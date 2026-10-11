import { LocalInstance } from "../../apps/hub-server/dist/local/instance.js";

const acquired = await LocalInstance.acquire(process.env.AH_TEST_DATA, "process-test");
if (typeof acquired === "string") {
  if (acquired !== "process-test-entry") throw new Error("Unexpected test entry");
  process.send?.({ type: "ready", role: "reopened" });
  process.disconnect();
} else {
  if (process.env.AH_TEST_BEFORE_SERVE !== "1") await acquired.serve(() => "process-test-entry");
  process.on("message", async (message) => {
    if (message?.type !== "shutdown") return;
    await acquired.close();
    process.disconnect();
  });
  process.send?.({ type: "ready", role: "owner" });
}
