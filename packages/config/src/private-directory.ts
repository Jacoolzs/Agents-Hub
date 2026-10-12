import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A dedicated new directory only; existing permissions are verified, never repaired. */
export async function privateDirectory(directory: string) {
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (created) await verifyPrivatePath(directory, true);
  else {
    // A concurrent first launch may still be setting the new Windows directory's ACL.
    const deadline = Date.now() + 3000;
    while (true) {
      try {
        await verifyPrivatePath(directory);
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await sleep(100);
      }
    }
  }
}

export async function verifyPrivatePath(
  target: string,
  initializeNewPath = false,
  maxBytes = 4096,
) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144)
    throw new Error("Invalid private file size limit");
  const info = await lstat(target);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    throw new Error("Private instance path is not a regular file or directory");
  if (info.isFile() && info.size > maxBytes)
    throw new Error("Private instance record is too large");
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("Private instance path has unsafe permissions");
    return;
  }
  // No secrets/paths interpolated into a shell command; target travels through a scoped env value.
  await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$ErrorActionPreference = 'Stop'
$targetPath = $env:AGENTS_HUB_PRIVATE_PATH
$operatorSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$privateInfo = if ($env:AGENTS_HUB_PRIVATE_KIND -eq 'directory') { New-Object System.IO.DirectoryInfo($targetPath) } else { New-Object System.IO.FileInfo($targetPath) }
if ($env:AGENTS_HUB_PRIVATE_INITIALIZE -eq '1') {
  $privateAcl = if ($env:AGENTS_HUB_PRIVATE_KIND -eq 'directory') { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
  $privateAcl.SetOwner($operatorSid)
  $privateAcl.SetAccessRuleProtection($true, $false)
  $privateRule = if ($env:AGENTS_HUB_PRIVATE_KIND -eq 'directory') { New-Object System.Security.AccessControl.FileSystemAccessRule($operatorSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') } else { New-Object System.Security.AccessControl.FileSystemAccessRule($operatorSid, 'FullControl', 'Allow') }
  $privateAcl.AddAccessRule($privateRule)
  $privateInfo.SetAccessControl($privateAcl)
}
$observedAcl = $privateInfo.GetAccessControl()
if ($observedAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $operatorSid.Value) { throw 'Private owner mismatch' }
$observedRules = $observedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($observedRules.Count -eq 0) { throw 'Private permissions missing' }
foreach ($observedRule in $observedRules) {
  if ($observedRule.IdentityReference.Value -ne $operatorSid.Value -or $observedRule.AccessControlType -ne 'Allow') { throw 'Private permissions unsafe' }
}
`,
    ],
    {
      windowsHide: true,
      timeout: 10000,
      env: {
        ...process.env,
        AGENTS_HUB_PRIVATE_PATH: target,
        AGENTS_HUB_PRIVATE_KIND: info.isDirectory() ? "directory" : "file",
        AGENTS_HUB_PRIVATE_INITIALIZE: initializeNewPath ? "1" : "0",
      },
    },
  ).catch((error) => {
    throw new Error("Private instance permissions could not be verified", { cause: error });
  });
}
