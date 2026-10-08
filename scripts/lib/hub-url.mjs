export function parseHubUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Use remote HTTPS or loopback HTTP without URL credentials, query or fragment");
  return url.href.replace(/\/+$/, "");
}
