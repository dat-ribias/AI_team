# Luật chung cho mọi AI member

1. Mã hóa
   - Mọi file ghi bằng UTF-8. Trên Windows KHÔNG dùng PowerShell `Set-Content`, `Out-File` hoặc pipe `>` để ghi file có tiếng Việt/Nhật (console cp932 làm hỏng dấu → mojibake). Dùng `apply_patch` hoặc `node -e` với `fs.writeFileSync(path, text, 'utf8')`. Sau khi sửa `locales/*.json`, phải `JSON.parse` lại và kiểm tra không có 'Ã', 'á»', '\uFFFD'.
2. Test
   - Builder KHÔNG chạy cả `test/system.test.js` (~13 phút, controller tự chạy ở bước test). Chỉ chạy test liên quan bằng `--test-name-pattern` hoặc file test riêng, luôn kèm `--test-timeout`; mỗi lượt gọi phải xong trong dưới 25 phút.
3. Tiến trình
   - Test/demo tự khởi động server hay tiến trình con phải tự dừng trong `finally`/`t.after` (đã từng treo `node --test` 19 giờ). Server demo dùng cổng 3334/3335 và data dir tạm; tuyệt đối không đụng cổng 3333 và `D:\ai_team\.team\state`.
4. Bảo mật
   - Không đọc/ghi credential, token, `auth.json`, `.credentials.json`; nếu cần thì chỉ đo kích thước.
5. Phạm vi
   - Chỉ sửa file được giao trong task. Nhiều job chạy song song cùng sửa `src/team.js`, `public/app.js`, `locales`, nên không format lại hay di chuyển code ngoài vùng được giao; với locale chỉ THÊM key, không sắp xếp lại. Nếu phát hiện lỗi chặn ngoài phạm vi, báo rõ nguyên nhân + `file:dòng` để Lead giao tiếp, không dừng im.
6. Bằng chứng
   - Log/ảnh lưu trong `.ai-team/evidence/` (không commit); việc UI phải có ảnh desktop và mobile. Dashboard có CSP cấm `style=""` inline: không dùng thuộc tính style trong HTML string (cột biểu đồ, màu, kích thước sẽ bị bỏ qua); dùng class CSS, thuộc tính SVG (`height/fill/x/y`) hoặc gán `el.style` qua CSSOM sau khi gắn DOM.
7. Git
   - Không commit, push hay merge; controller làm việc này.
