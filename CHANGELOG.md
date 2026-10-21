# Lịch sử thay đổi

- 2026-10-21 · Phản biện plan cho mọi job code, ChatGPT chỉ tư vấn chung · `challenge` mặc định `all`: plan rủi ro thấp/vừa được phản biện nhanh bằng Claude `challengeModel` (mặc định haiku), rủi ro cao giữ người phản biện mạnh; `challenge: "high"` về như cũ. Bỏ câu hỏi ChatGPT tự động trước plan cho job code (ChatGPT không thấy repo); hướng dẫn Lead/builder chỉ hỏi ChatGPT câu kiến thức chung, đủ ý.
- 2026-10-21 · Node Phản biện plan và ChatGPT trả lời trọn · Sơ đồ có node **Phản biện plan** dưới Manager: đang chạy, số phản đối (bấm xem từng phản đối + bằng chứng) hoặc "bỏ qua · chỉ khi rủi ro cao"; kết quả lưu ở `job.challengeResult`. Câu hỏi gửi ChatGPT web có đoạn dặn "không truy cập được repo, trả lời ngay trong một tin"; phát hiện trả lời xong kiểm lại thêm một nhịp để không lấy nhầm câu mở đầu khi model dừng ngắn rồi chạy tiếp.
- 2026-10-21 · Task song song không kẹt vì xung đột · Khi làm tiếp task trên nhánh con mà gộp đầu nhánh job mới bị xung đột: cất phần dở vào tag `archive/<nhánh>-conflict-<sha>` và làm lại task từ code mới nhất của job thay vì dừng job. Job vướng hiện nhãn "vướng" thay vì "Chờ chủ duyệt".
- 2026-10-21 · Chọn model ChatGPT web · `oracle.model` / `accounts[].model` và ô **Model ChatGPT web** trong cài đặt: hệ thống bấm menu model của ChatGPT và chọn theo tên hiển thị (Instant / Thinking / Pro…) trước khi hỏi; kết quả thử kết nối hiện model đã dùng.
- 2026-10-21 · Thử kết nối ChatGPT web không treo im lặng · Tài khoản đang được job dùng thì báo ngay `account busy`; thử kết nối tối đa 2 phút; mỗi lệnh điều khiển trình duyệt tối đa 20 giây; lỗi timeout ghi rõ kẹt ở bước nào (ô nhập / gửi / chờ trả lời) kèm trạng thái trang và lưu ảnh trang `chatgpt-profiles/<tài khoản>-last-error.png`.
- 2026-10-21 · Sơ đồ đủ các vòng · Mỗi vòng đã qua vẽ thành sơ đồ đầy đủ (Manager → builder → Tests → Review → Verify) trong cùng SVG phía trên vòng hiện tại; bước hỏng tô đỏ, rê chuột xem tóm tắt và các lỗi; mũi tên nét đứt từ bước hỏng xuống Manager của vòng sau kèm lý do. Bot chat trả lời được "vòng 2 sao sai / vì sao chạy lại" nhờ gửi kèm chi tiết từng vòng của job đang được nhắc.
- 2026-10-21 · Dashboard nhanh hơn · `/api/state` đọc và parse các job một lần thay vì một lần cho mỗi job (phụ thuộc, hàng merge, quyết định): ~400 ms → ~20 ms với 36 job ~4 MB (Windows trước đó ~2 s).
- 2026-10-21 · Gửi ảnh/file qua chat · Ảnh và file gửi kèm trên Chatwork/Telegram được tải về và đính kèm vào job mới hoặc chỉ dẫn cho job; `/ketqua` và tin "gửi kết quả job X" gửi kèm file kết quả (docx/xlsx/pdf…).
- 2026-10-21 · Duyệt kết quả qua chat · Lệnh `/ketqua <id>` và tự gửi khi job sẵn sàng merge: tóm tắt từng task, test, review/verify, rủi ro, file đổi (không gửi diff), kèm ảnh preview trước/sau và báo cáo test upload lên Chatwork/Telegram. Tin chào hỏi/hỏi đáp được trả lời như chatbot thường.
- 2026-10-21 · Bot hiểu yêu cầu tự do · Tin nhắn không phải lệnh được phân tích (Claude Haiku, hết quota thì Gemini, cuối cùng là luật) thành làm tiếp/giao mới/trả lời Lead; hỏi lại dự án hoặc job khi mơ hồ bằng lựa chọn đánh số, tóm tắt và chờ y/n trước khi làm; câu hỏi Lead gửi nguyên văn vào chat để trả lời thẳng. Lệnh cố định bắt buộc có `/` (vd `/status`), tin không có `/` luôn là yêu cầu tự do. Test `test/intake.test.js`.
- 2026-10-21 · Điều khiển từ xa · Bot Chatwork/Telegram (polling, không cần tunnel) với lệnh status/can/jobs/job/new/duyet/msg/pause/resume/cancel/merge/quota và tự báo việc cần bạn; dashboard truy cập qua tunnel bằng `remote.hosts` + khóa truy cập, không tự cấp cookie cho host ngoài. Test `test/bot.test.js`, `test/remote-access.test.js`.
- 2026-10-21 · ChatGPT web không cần CLI · Thay CLI `oracle` bằng `src/chatgpt-web.js`: tự điều khiển Chrome/Edge có sẵn qua CDP, mỗi tài khoản một profile trong dataDir, nút **Đăng nhập ChatGPT** mở cửa sổ để đăng nhập một lần, sau đó hỏi ở cửa sổ ngoài màn hình; hỏi tiếp trong cùng cuộc trò chuyện của job; mã lỗi thêm `browser_missing`. Selector tham khảo codex-chatgpt-web (MIT, xem NOTICE.md). Test với trang ChatGPT giả `test/chatgpt-web.test.js`.
- 2026-10-21 · Board công việc · Dialog Danh sách công việc thành board 5 cột (Cần bạn / Đang làm / Đang đợi / Bị trả lại / Xong) có đếm số, thẻ việc ghi lý do, người làm, tiến độ task, hàng merge, rủi ro và nút hành động (Duyệt plan, Trả lời, Merge, Xem lỗi); chuyển Board/Danh sách (nhớ lựa chọn), lọc "Chỉ việc cần tôi", cột Xong thu gọn 8 việc gần nhất; thanh bên hiện "N việc cần bạn". Phân cột bằng `jobLane`, test `test/jobs-board.test.js`.
- 2026-10-21 · Sơ đồ flow theo vòng · Sơ đồ chỉ vẽ node có thật trong vòng hiện tại (builder có task, ChatGPT web khi có lượt hỏi, Tests với job code, Review/Verify theo flow; bước bỏ qua ghi chú). Mỗi vòng đã qua hiện thành một hàng phía trên kèm lý do quay lại (Review/Verify yêu cầu sửa, test fail, chỉ dẫn của bạn); nhiều vòng thì thu gọn. Lõi dữ liệu `flowRounds` có test `test/flow-rounds.test.js`.
- 2026-10-21 · Oracle cho job nghiên cứu · Builder có thể hỏi ChatGPT web ở bước research và khi implement job research; thêm chế độ/giới hạn riêng cho job research, thống kê lượt hỏi theo vai và ước tính số lượt gọi AI/token đã tiết kiệm. Hết lượt hoặc Oracle lỗi không chặn job.
- 2026-10-20 · UI phụ thuộc giữa job và hàng merge · Thêm chọn nhiều job chờ khi tạo/sửa, chip lý do và vị trí hàng merge, xử lý phụ thuộc hỏng bằng popup, lựa chọn tuần tự/song song và cảnh báo trùng file khi duyệt plan. Bổ sung bản dịch vi/en/ja, tài liệu điều kiện đạt và hướng giai đoạn 2; UI dùng hợp đồng API phụ thuộc/hàng merge.
- 2026-10-20 · Ngôn ngữ theo job · Thêm `job.lang`, tự nhận diện `vi` / `ja` / `en` từ goal và cập nhật từ tin nhắn owner khi đủ tin cậy; hỗ trợ `lang` lúc tạo job và control action `language` để ghi đè. Mọi prompt yêu cầu văn bản cho người đọc theo ngôn ngữ job; báo cáo rõ ràng sai ngôn ngữ được gọi lại đúng một lần, sau đó chỉ cảnh báo và không chặn. Chuỗi ASCII ngắn, đường dẫn, hash và log không làm đổi ngôn ngữ; thông báo controller ưu tiên locale của job khi có.
- 2026-10-20 · Oracle · Thống kê Oracle hiểu mốc ngày theo múi giờ báo cáo.
- 2026-10-20 · Backend ChatGPT web (Oracle) · Thêm chế độ `off` / `auto` / `required` và ghi đè `oracleMode` theo job; hỏi tự động một lần trước plan, resume không gửi lại, lỗi vẫn tiếp tục. Lưu thời gian chờ/trả lời, mã lỗi và event `ORACLE_ERROR`, giữ `ORACLE_QUESTION` / `ORACLE_ANSWER`; lưu lý do Lead bỏ qua. Thêm API thử kết nối theo tài khoản dùng chung hàng đợi và thống kê theo ngày/job/dự án, nhận diện phiên web hết hạn; kiểm tra bằng adapter Oracle giả và router không mở cổng.

- 2026-10-19 · Thống nhất trạng thái job và đối soát Git · Bổ sung 7 trạng thái: Đang làm / Chờ chủ duyệt / Đã vào master / Kẹt merge / Hủy – còn code chưa vào master / Hủy – sạch / Xong. Đối soát định kỳ và khi mở dashboard bằng quan hệ tổ tiên trên nhánh chính, nhận diện merge tay và đối soát riêng repo liên kết; job đã vào dev nhưng chưa lên master là “Chờ chủ duyệt (RC)”, chủ duyệt RC trước khi lên master. Cấu hình nhánh qua `project.mainBranch` / `project.integrationBranch`.
- 2026-10-19 · Hộp Cần anh quyết định · Mỗi job cần chủ hành động có một dòng và lý do, badge/toast báo mục mới; xác nhận bằng popup trong trang. Phân loại lỗi merge: `base_moved` tự sync và test lại, `conflict` liệt kê file cần người xử lý, `tests_failed` trả về builder.
- 2026-10-19 · Dọn dẹp và trang Mồ côi · Merge xong dọn branch và mọi worktree, kể cả `-review-*`; giữ worktree bẩn. Hủy/xóa tạo tag `archive/<branch>` trước khi xóa branch (bỏ tiền tố `ai-team/`, gồm cả `-tN` và `-wip-tN`); xóa job còn code chưa vào master cần xác nhận archive. Trang Mồ côi liệt kê branch/worktree không thuộc job, cờ đã vào master/chưa và ngày commit cuối, cho chủ chọn xóa một lượt và archive branch chưa vào master; API `GET /api/orphans`, `POST /api/orphans/delete`.
- 2026-10-19 · Đặt tên Git theo task và cô lập test · Branch `ai-team/<id>-<slug>`, commit `<tiêu đề task> (<member>)` với tác giả là member AI, merge `Merge: <tiêu đề> [#<id>]`; merge sub-task dùng tiêu đề sub-task thay T1/T2. Test dùng repo tạm và tự dọn branch/worktree, không còn đụng repo thật.

- 2026-10-15 · Thêm settings và lịch sử hỏi/đáp thu gọn cho Lead tham khảo ChatGPT web bằng quota web ở bước plan, cùng tài liệu cấu hình Oracle.

Nguồn: lịch sử `master` tại `072ccb2` và bảng jobs đọc chỉ đọc ngày 2026-10-14. Mỗi job đã có commit trong master ghi một lần; ngày lấy từ commit mới nhất của job trong lịch sử này (riêng merge trực tiếp vào master dùng ngày merge). Tiêu đề/tóm tắt job được rút gọn từ goal và báo cáo cuối trong DB khi job cũ chưa có title. Commit không gắn job giữ tiêu đề Git, không suy đoán nội dung. Không bao gồm job của repo khác.

## 2026-10-14

- 2026-10-14 · 64c59397 · Tự thử lại và đổi provider khi lỗi tạm thời · Tự thử lại lỗi mạng/503, thay người theo quota cho các vai trò và tự xếp hàng lại khi có người khả dụng.
- 2026-10-14 · 0daac6de · Tiêu đề job và danh sách công việc gọn · Thêm tiêu đề ngắn, đổi tên và tìm kiếm qua UI/API/MCP, giữ mục tiêu đầy đủ trong chi tiết.
- 2026-10-14 · a758eeb5 · Tên AI trong Git và ổn định tab Kết quả · Ghi tác giả checkpoint theo member và giữ trạng thái tab Kết quả khi nhận sự kiện SSE.
- 2026-10-14 · 5fe43a54 · Tab Kết quả, preview runner và nghiệm thu · Cho owner xem kết quả thực tế và nghiệm thu đúng revision trước khi merge.

## 2026-10-13

- 2026-10-13 · fe14daf8 · Duyệt kế hoạch và lịch sử phiên bản kế hoạch · Thêm cổng owner duyệt kế hoạch cùng lịch sử các phiên bản và phản hồi.

## 2026-10-09

- 2026-10-09 · — · new · Commit d87204c; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-09 · — · new · Commit 174d5c0; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-09 · 0a1f796d · Hồ sơ kiểm tra và chọn branch · Tập hợp bằng chứng test/review/verify và cho chọn branch gốc, branch đích khi merge.
- 2026-10-09 · — · new · Commit 53882e4; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.

## 2026-10-08

- 2026-10-08 · — · new · Commit f7278a4; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-08 · — · new · Commit 7f55ef4; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.

## 2026-10-07

- 2026-10-07 · — · new · Commit 05caf11; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-07 · — · new · Commit 0b9bac2; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.

## 2026-10-06

- 2026-10-06 · — · test · Commit 282264d; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-06 · — · t · Commit 2e98525; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-06 · — · test · Commit 5da6c3e; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-06 · — · test · Commit 08008d1; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-06 · — · test · Commit 656b642; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-06 · — · test · Commit 688d10c; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.

## 2026-10-05

- 2026-10-05 · — · ok · Commit 3538f0a; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-05 · — · new · Commit 93238d5; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-05 · — · check rule · Commit 4796563; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-05 · — · Add team.config.example.json template; stop tracking machine-specific team.config.json · Commit 212dbde; ghi nhận thay đổi theo tiêu đề commit gốc.

## 2026-10-02

- 2026-10-02 · — · test-pc-pri · Commit 90c3722; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-02 · — · next · Commit 09ec3ff; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-02 · — · ss · Commit 98fcf4d; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-02 · — · ad team · Commit 91ef9c9; thông điệp Git không mô tả chi tiết thay đổi, không có job tương ứng để đối chiếu.
- 2026-10-02 · — · fix UI · Commit 92d812a; ghi nhận thay đổi theo tiêu đề commit gốc.

## 2026-10-01

- 2026-10-01 · — · feat(ui): add jobs popup dialog and improve sidebar jobs list · Commit 89d7a2b; ghi nhận thay đổi theo tiêu đề commit gốc.
- 2026-10-01 · — · feat(ui): display full titles and mood text with dynamic font shrinking without truncation · Commit 0fe3745; ghi nhận thay đổi theo tiêu đề commit gốc.
- 2026-10-01 · — · fix(ui): eliminate undefined subtitle and prevent Flow node text overflow · Commit cc18842; ghi nhận thay đổi theo tiêu đề commit gốc.
- 2026-10-01 · — · feat: replace icons with 10% emotional mood scale from fantastic to strike · Commit 4200df5; ghi nhận thay đổi theo tiêu đề commit gốc.
- 2026-10-01 · — · feat: add member health status indicator to communication chat and workflow flow · Commit d904899; ghi nhận thay đổi theo tiêu đề commit gốc.
- 2026-10-01 · — · fix: standardize claude quota parsing and display both used and remaining percentages · Commit 1eaa308; ghi nhận thay đổi theo tiêu đề commit gốc.
- 2026-10-01 · — · update: codex sandbox windows support and quota UI · Commit 238485f; ghi nhận thay đổi theo tiêu đề commit gốc.
- 2026-10-01 · — · v1.1 · Commit 4c2ffce; ghi nhận thay đổi theo tiêu đề commit gốc.
- 2026-10-01 · — · v1 · Commit d1e686d; ghi nhận thay đổi theo tiêu đề commit gốc.
