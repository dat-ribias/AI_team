import { askChatGpt } from './chatgpt-web.js';

// ChatGPT web (node "ChatGPT web" của Lead/builder): điều khiển trực tiếp Chrome/Edge trên máy qua src/chatgpt-web.js,
// không cần CLI hay launcher ngoài. Hợp đồng giữ nguyên cho askOracle/testOracle: → { answer, session }, session là URL
// cuộc trò chuyện để hỏi tiếp trong cùng chat; lỗi luôn bắt đầu bằng "ChatGPT web:" để phân loại mã lỗi.
export async function runOracle({ profileDir, prompt, followup, model, timeoutMs = 600_000, signal, chrome, baseUrl, headless }) {
  if (!profileDir) throw new Error('ChatGPT web: missing browser profile');
  return askChatGpt({ profileDir, prompt, followup, model, timeoutMs, signal, chrome, baseUrl, headless });
}
