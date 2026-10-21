# Quy ước riêng của repo work-team

- Bộ test hệ thống đã tách thành `test/system-1..4.test.js` (helper chung ở `test/system-helpers.js`); controller chạy song song cả bộ ở bước test (~5 phút). Builder chỉ chạy file liên quan, dùng `--test-name-pattern` và luôn kèm `--test-timeout`. Test mới thêm vào file system-N nhẹ nhất, không thêm vào `test/system.test.js` (chỉ là file gom).
- Test nhanh: `node --test --test-timeout=120000 test/quota-failover.test.js test/transient-failover.test.js`.
- Claude builder chỉ chạy được `node --test`, `node --check`, `npm test` và lệnh test của project (không có `node -e`); ghi/sửa locale bằng công cụ Edit.
- Server demo dùng cổng 3334/3335 và data dir tạm; không đụng cổng 3333 hoặc `D:\ai_team\.team\state`.
- Dashboard có CSP cấm thuộc tính `style` inline trong HTML. Dùng class CSS, thuộc tính SVG (`height/fill/x/y`) hoặc gán `el.style` qua CSSOM sau khi gắn DOM.
- Với `locales/*.json`, chỉ THÊM key, không sắp xếp lại; thêm NGAY SAU key cùng tiền tố (ví dụ `ui.jobs.*` cạnh `ui.jobs.*`), KHÔNG thêm vào cuối file vì mọi job cùng chèn ở cuối nên luôn xung đột khi merge. Kiểm tra `JSON.parse` và mojibake (`Ã`, `á»`, `\uFFFD`) sau khi sửa.
- Nhiều job cùng sửa `src/team.js`, `public/app.js`, `locales`; không format lại hoặc di chuyển code ngoài vùng được giao.
- Công việc UI phải có ảnh desktop và mobile.
- Việc tham khảo/so sánh/tổng hợp kiến thức chung (sản phẩm, thiết kế, best practice) hỏi ChatGPT web trước; agent chỉ tự đọc web để kiểm chứng nguồn hoặc phần còn thiếu.

## Luồng công việc (Lead áp dụng khi lập plan)
- Một job = một tính năng. Goal có nhiều mục độc lập thì đề xuất tách job trong summary thay vì gom vào một plan lớn.
- Xem `otherJobs`: job khác đang sửa cùng file lớn (`src/team.js`, `public/app.js`, `public/style.css`, `locales`) thì ghi rõ trong riskReasons và giữ thay đổi ở vùng nhỏ nhất.
- KHÔNG tự chặn job vì job khác chưa merge. Sửa trùng file với job khác thì cứ làm trên master hiện tại; controller đồng bộ và gộp xung đột lúc merge. Chỉ trả `needs_input` khi THẬT SỰ cần code chưa tồn tại ở bất kỳ đâu (không có trong master lẫn nhánh của job đó); khi dữ liệu của job khác chưa có, viết code đọc trường đó nếu có và bỏ qua nếu không.
- Code vào master chỉ qua merge của job; không sửa trực tiếp master.
