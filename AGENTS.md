# Quy ước riêng của repo work-team

- Không chạy toàn bộ `test/system.test.js` (khoảng 13–16 phút); controller chạy ở bước test. Chạy file test liên quan, dùng `--test-name-pattern` để lọc ca cần thiết và luôn kèm `--test-timeout`.
- Test nhanh: `node --test --test-timeout=120000 test/quota-failover.test.js test/transient-failover.test.js`.
- Claude builder chỉ chạy được `node --test`, `node --check`, `npm test` và lệnh test của project (không có `node -e`); ghi/sửa locale bằng công cụ Edit.
- Server demo dùng cổng 3334/3335 và data dir tạm; không đụng cổng 3333 hoặc `D:\ai_team\.team\state`.
- Dashboard có CSP cấm thuộc tính `style` inline trong HTML. Dùng class CSS, thuộc tính SVG (`height/fill/x/y`) hoặc gán `el.style` qua CSSOM sau khi gắn DOM.
- Với `locales/*.json`, chỉ THÊM key, không sắp xếp lại; kiểm tra `JSON.parse` và mojibake (`Ã`, `á»`, `\uFFFD`) sau khi sửa.
- Nhiều job cùng sửa `src/team.js`, `public/app.js`, `locales`; không format lại hoặc di chuyển code ngoài vùng được giao.
- Công việc UI phải có ảnh desktop và mobile.
