# Việc còn mở

Ảnh chụp trạng thái DB ngày 2026-10-14, đối chiếu master `072ccb2`; trạng thái có thể đổi sau thời điểm này. `ready` vẫn cần owner nghiệm thu/merge; `done` là nghiên cứu đã kết thúc, không phải việc đang chạy.

## 1. Đang chạy/chờ

Bao gồm các job có status khác `merged`/`cancelled`; ghi project để tránh nhầm việc của repo khác.

| ID | Tiêu đề | Trạng thái | Project |
|---|---|---|---|
| d863d4cc | Việc code nhỏ để kiểm thử pipeline: thêm dòng `_to_delete/` vào .gitignore, ngay dưới mục "# Backup & temporary files". Không sửa gì khác. Dùng rigor "strict" để chạy đủ review và verify: Reviewer và Verifier phải TỰ chạy các lệnh trong "checks" (node --test test/system.test.js) và ghi kết quả thật vào "tests". | ready | work-team |
| 28a4e65b | Làm lại toàn bộ UI/UX + animation của FE_NEW để đạt mức ứng dụng nội bộ chuyên nghiệp cho công ty Nhật (Ribias), chạy tốt trên PC, tablet (iPad là thiết bị chính của công ty) và điện thoại, tương thích đầy đủ các trình duyệt phổ biến. KHÔNG đổi logic nghiệp vụ/auth/permission/API đã có; 172 test hiện tại phải tiếp tục pass. | ready | fe-new |
| ea80865e | NGHIÊN CỨU CHỈ ĐỌC: review 10 file .md trong D:\w\FE_NEW\docs (thư mục tham khảo, chỉ đọc). Không tạo/sửa/xóa file nào ở đó. Với từng file: tóm tắt mục đích, chỉ ra chỗ sai/mâu thuẫn/thiếu/lỗi thời (kèm file:dòng), và đề xuất sửa. Cuối cùng tổng hợp: mâu thuẫn giữa các file, thứ tự ưu tiên sửa. Báo cáo bằng tiếng Việt. | done | work-team |
| 41b66c37 | kiểm tra xem là dự án này đã tuân thủ bảo mật chưa? | done | work-team |
| 0b1680da | kiểm tra xem dữ liệu data đã luân chueyenr chuẩn chưa? | done | work-team |
| e7c3d806 | NGHIÊN CỨU (chỉ đọc, không sửa code): KIỂM TRA TỔNG THỂ TRẢI NGHIỆM DÙNG AI Team Control Room như một owner thật, tìm mọi chỗ chưa hoàn thiện / chắp vá. Báo cáo cuối tiếng Việt, kèm ảnh chụp. | done | work-team |
| 440ae40e | NGHIÊN CỨU (chỉ đọc, không sửa code) cho AI Team Control Room (repo này) + máy đang chạy nó. Báo cáo cuối bằng tiếng Việt, có số liệu thật (dung lượng, số file, đường dẫn), mỗi kết luận kèm bằng chứng (lệnh đã chạy hoặc file:dòng). | done | work-team |
| c6af7706 | Xây dựng tool kiểm thử tải (load test) cho web nội bộ theo đúng spec trong file SPEC.md ở gốc repo. Đọc kỹ SPEC.md trước khi lập kế hoạch: mục tiêu, ràng buộc, cấu trúc file, tiêu chí nghiệm thu và phần ngoài phạm vi đều nằm trong đó. | paused | test-web-naibu |
| b459c4b2 | [Tiêu đề] Lead biết quyền từng loại job + kiểm tra kế hoạch khả thi | ready | work-team |
| 1b0e8c0c | Quy trình động bước 1: task kind mới + sơ đồ theo đồ thị | waiting | work-team |
| 656732d7 | Nghiên cứu kỹ và thiết kế bộ ARTWORK cho module Thank Card:… | ready | fe-new |
| 6137d872 | Kiểm quota song song, có Claude, có tiến độ | running | work-team |
| e82c76c7 | Sửa nút Kiểm tra mở đúng run | running | work-team |
| 9358adbc | Hoàn thiện và gỡ blocker tab Token | running | work-team |
| b4a40d93 | Tài liệu tổng quan: OVERVIEW + CHANGELOG + ROADMAP | running | work-team |
| 9eba867f | Tạo AGENTS.md: luật chung cho AI member | ready | work-team |
| ee7d63ba | Sửa hồi quy dọn tự động và đồng bộ trạng thái | ready | work-team |
| 2b699046 | Quản lý prompt 2 cấp: hệ thống ngắn gọn + prompt riêng từng… | running | work-team |

Các job a758eeb5, 0daac6de và 64c59397 đã là `merged` trong DB và có commit trong master, nên không còn nằm trong danh sách chờ. Job 28a4e65b vẫn là `ready` trong DB dù goal của job FE_NEW kế tiếp nói đã merge; cần owner đối chiếu repo FE_NEW trước khi sửa trạng thái.

## 2. Đã đề xuất nhưng chưa giao

- Audit e7c3d806 đề xuất thứ tự A → B → C → D, làm tuần tự và rebase sau mỗi job vì cùng sửa team.js/app.js/locales. Task context gắn A với e82c76c7, nhưng DB hiện đặt tên e82c76c7 là “Sửa nút Kiểm tra mở đúng run”; chưa đủ căn cứ coi toàn bộ bảo toàn tiến độ của A đã được giao. Cần đối chiếu phạm vi trước khi giao thêm.
- B — Vòng đời/hội thoại: tạo job tiếp nối từ research done hoặc code merged, nháp theo từng job và thống nhất hành động owner giữa UI/backend; phối hợp với 1b0e8c0c.
- C — Kết quả/conflict: làm rõ preview, nghiệm thu theo revision, diff, cập nhật base và conflict giữa job; tiếp nhận thay đổi a758eeb5 đã vào master.
- D — Thuật ngữ/trải nghiệm: thống nhất tên trạng thái và hành động vi/en/ja, bàn phím, touch target, empty/loading/error/disabled, thông báo cần owner; thực hiện sau khi luồng B/C ổn định.
- Nghiên cứu 440ae40e: quản lý skill/prompt/rule/memory hai cấp hệ thống và project, tận dụng config + SQLite + Git; rule repo ở AGENTS.md, tránh nhân bản nguồn. Đề xuất thứ tự ưu tiên hệ thống < project < phiên < task, ngân sách ký tự prompt và hàng đợi knowledge_changes để AI đề xuất, owner duyệt trước khi áp dụng. Sửa redact, promotion và provenance memory trước khi xây quản lý tập trung. Đây là thiết kế đề xuất, không khẳng định cấu hình project đã tồn tại. Job 2b699046 đang triển khai phần prompt hai cấp; các phần skill/rule/memory và hàng đợi còn cần đối chiếu phạm vi rồi giao riêng.
- Quy trình động bước 2: chỉ giao sau 1b0e8c0c (bước 1: task kind mới và sơ đồ theo đồ thị); chốt phạm vi từ kết quả bước 1 trước khi mở job tiếp theo.

## 3. Rủi ro/hạn chế đã biết

Đối chiếu tĩnh trên code `072ccb2`, không phải kết quả tái hiện động; các job đang chạy có thể sửa những điểm này.

- `redact()` chưa che đầy đủ ghp_, AKIA và token sau Bearer/Authorization (`src/team.js:48`).
- Task song song lỗi/timeout vẫn bị xóa worktree con bằng `--force`; commitAll chỉ chạy sau lời gọi thành công nên có thể mất code chưa commit (`src/team.js:1386–1408`).
- Timeout subprocess mặc định 30 phút tính theo tổng thời gian, không có cảnh báo agent im lặng; provider không truyền timeout riêng (`src/process.js:114`, `src/providers.js`).
- `providerDowns` chỉ lưu trong Map; restart controller mất cooldown provider (`src/team.js:227,817–820`).
- `saveObserved()` canonical hóa bucket theo tên Claude mà không kiểm provider, có thể gộp sai bucket; migration lúc khởi động đã có điều kiện Claude, nhưng đường lưu này vẫn chưa có (`src/team.js:2345–2368`).
- Events/evidence chưa có retention theo tuổi/dung lượng; xóa job có xóa events, nhưng `events()` vẫn giới hạn 2000 dòng mỗi lượt, bên gọi không phân trang có thể thiếu dữ liệu (`src/team.js:617,1981`; dashboard đã phân trang ở `public/app.js:1174`).
- UI còn mở chat/Góp ý cho job done dù backend coi done là terminal và từ chối control (`public/app.js:650,813`, `src/team.js:37,1984`).
- Dashboard refresh chỉ chọn job theo project/session khi selected đang rỗng, chưa xác minh selected hiện tại còn thuộc ngữ cảnh đó (`public/app.js:1169`).
- MCP delegate_task chưa nhận/truyền sessionId, nên dùng phiên do backend tự chọn (`src/mcp.js:21`, `src/team.js:588–593`).
- Chưa thấy test chuyên biệt cho concurrent messages, stale pause save, parity session HTTP/MCP và cooldown quota/provider qua restart; test hiện có đã phủ pause/resume, stale cancel, stale assignee và orphan slot sau restart (`test/system.test.js`, `test/quota-failover.test.js`, `test/transient-failover.test.js`).
