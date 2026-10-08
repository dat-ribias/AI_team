# Nghiên cứu nền tảng — 2026-10-01

Đối chiếu README, tài liệu chính thức, changelog và metadata GitHub tại thời điểm triển khai. “Đáng tham khảo” ở đây dựa trên nguồn duy trì và tính phù hợp; không phải chứng nhận an toàn hay audit toàn bộ code.

| Repo / nguồn | Kết quả xác minh | Áp dụng |
|---|---|---|
| [openai/codex](https://github.com/openai/codex) | Repo chính thức, Apache-2.0, đang hoạt động; máy có CLI 0.104.0 | Dùng CLI đang có và app-server chính thức, không tự gọi endpoint nội bộ bằng token |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | URL ComposioHQ cũ chuyển tới repo này; README hiện có Windows, workspace/worktree, worker và orchestrator; Apache-2.0 theo metadata hiện tại | Tham khảo cách gắn task, worktree, hội thoại, review và CI vào một phiên công việc |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | Apache-2.0; README ghi “Vibe Kanban is sunsetting”, dù GitHub chưa đánh dấu archived | Tham khảo UX task/diff; không chọn làm dependency nền của bản dựng |
| [google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli) | Repo chính thức cung cấp tài liệu/release; GitHub metadata không đưa license SPDX tại lần kiểm tra | Gọi binary chính thức bên ngoài; không sao chép hoặc phân phối lại code/binary |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | SDK chính thức; package npm 1.31.0 đã cài với lockfile | Dùng cho MCP stdio, tránh tự triển khai protocol |

Không clone/fork cả orchestrator khác: nhu cầu hiện tại là bốn identity cố định, chạy on-demand, quota tập trung và log giao tiếp. Bản này dùng Node HTTP, SQLite, child_process và giao diện HTML/CSS/JS trực tiếp. Phần tham khảo là thiết kế workflow, không sao chép mã nguồn repo.

## Các điểm cần điều chỉnh/kiểm chứng so với kế hoạch ban đầu

1. [OpenAI Authentication](https://learn.chatgpt.com/docs/auth) xác nhận credential dạng file trong CODEX_HOME. Setup tạo ba home riêng, ép `cli_auth_credentials_store="file"`, không sửa home Codex Desktop đang dùng.
2. [OpenAI non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode) và `codex exec --help` tại máy xác nhận `--json`, sandbox và stdin prompt. Adapter dùng đúng khả năng CLI đã cài; không pin model chưa được người dùng chọn.
3. [OpenAI app-server](https://learn.chatgpt.com/docs/app-server) quy định initialize → initialized → account/read / account/rateLimits/read. Quota có thể nhiều bucket; ưu tiên rateLimitsByLimitId và không mặc định primary luôn là 5 giờ.
4. [Thông báo Google](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) xác nhận chuyển tài khoản cá nhân Google AI Pro/Ultra khỏi Gemini CLI ngày 18/06/2026; doanh nghiệp/API là trường hợp khác.
5. [Antigravity headless](https://antigravity.google/docs/cli/headless/) xác nhận stream-json, event/result và quyền hạn headless. Exit code 0 không đủ để khẳng định hoàn thành: adapter kiểm tra result status và JSON report.
6. [Changelog Antigravity](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md) và [issue #590 đã đóng](https://github.com/google-antigravity/antigravity-cli/issues/590) xác nhận bản mới hỗ trợ `agy -p /usage --output-format json` không mở agent turn. Cần kiểm tra phiên bản trước khi bật collector; CLI cũ từng coi slash command là prompt.
7. Không giả vờ có quota thật khi chưa login, khi CLI thiếu, hoặc schema không nhận diện. Bộ thu hiện chưa được chạy với bốn tài khoản thật.

## Quyết định triển khai

Một worker slot toàn hệ thống để giảm tải. Một worktree cho mỗi job, các builder sửa tuần tự; Google review có detached snapshot riêng. Test/review/verify gắn commit SHA. Tất cả giao việc, kết quả và quyết định điều phối được lưu trong SQLite; SSE đẩy thông báo cập nhật tới browser. Cổng mặc định 3333 cho live, 3334 cho demo. UI chỉ bind 127.0.0.1, kiểm tra Host/Origin và yêu cầu session + custom header cho mutation.

MCP là một đầu vào tùy chọn cho manager bên ngoài. Workflow mặc định không cần manager giữ process sống hoặc polling CLI liên tục. Quota được đọc mỗi 5 phút và lưu history; không ước tính quota subscription từ lượng token của task.

## Bổ sung về đối thoại và trí nhớ — 2026-10-08

[Debate or Vote](https://arxiv.org/abs/2508.17536) tách lợi ích của lấy nhiều câu trả lời khỏi lợi ích trao đổi trong các benchmark NLP. [Free-MAD](https://aclanthology.org/2026.findings-acl.1600/) khảo sát quyết định không buộc đồng thuận. [Demystifying Multi-Agent Debate](https://aclanthology.org/2026.findings-acl.1694/) nghiên cứu cập nhật lập trường và hiệu chỉnh confidence. Các kết quả này không xác nhận hiệu quả trong pipeline sửa code tại đây; đặc biệt không lấy confidence tự báo làm trọng số đúng/sai. [MAST](https://github.com/multi-agent-systems-failure-taxonomy/MAST) cung cấp phân loại lỗi để xem xét các failure giữa agent.

Áp dụng ở mức cơ chế: phân tích độc lập trước trao đổi là lựa chọn; claim/message/evidence có ID; quyết định kèm nghĩa vụ/điều kiện; fingerprint nội dung làm cũ bằng chứng; ownership và nghĩa vụ được bàn giao. Dùng lại JSON job trong SQLite, không thêm framework/database. So sánh tạo ba job cùng đầu vào/trần ngân sách, ghi usage thật và nhãn sai→đúng/đúng→sai do người đánh giá kèm bằng chứng. Kiểm thử mô phỏng chứng minh luồng vận hành, chưa chứng minh chất lượng AI thật tăng.
