export function sendScormMessage(payload: Record<string, any>) {
  if (typeof window !== "undefined" && window.parent) {
    window.parent.postMessage({ type: "scorm", ...payload }, "*");
  }
}

export const sendScore = (score: number) =>
  sendScormMessage({ event: "score", score });

export const sendProgress = (progress: number) =>
  sendScormMessage({ event: "progress", progress });

export const sendCompleted = () => sendScormMessage({ event: "completed" });

export const sendExit = () => sendScormMessage({ event: "exit" });