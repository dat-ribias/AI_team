# AI Team Control Room

Dashboard local cho 3 Codex profile + 1 Google reviewer. Chạy Node.js 24, SQLite có sẵn trong Node và SDK MCP chính thức. Giao diện không cần build, Docker, React hay dịch vụ cloud riêng.

## Trạng thái bàn giao

- Đã triển khai hàng đợi, manager phân chia việc bằng JSON, worker theo từng bước, Git worktree, checkpoint, kiểm thử thực, vòng review/sửa có giới hạn, verifier, báo cáo và merge có duyệt.
- Có timeline, lọc theo agent, hoạt động CLI, quyết định, blocker, diff, tạm dừng/hủy/tiếp tục, đổi builder, gửi chỉ dẫn, dashboard quota và lịch sử quota.
- Có adapter `codex exec`, Codex app-server quota, Antigravity headless/quota và Gemini CLI cho tài khoản phù hợp; chưa kiểm chứng end-to-end với tài khoản thật của bạn.
- Demo sử dụng agent giả được ghi rõ. Repo, Git, SQLite, kiểm thử và điều kiện merge trong demo là thật. Không suy diễn quota từ token.
- Cần hoàn tất: đăng nhập ba profile, chọn Google CLI đúng loại tài khoản, đăng ký repo mục tiêu và lệnh kiểm thử.

## Chạy

```powershell
cd D:\work_team
npm ci --ignore-scripts
npm run setup
npm start
```

Mở <http://127.0.0.1:3333>. Chỉ bind loopback; dùng địa chỉ này, không dùng `localhost`. Ctrl+C để dừng nếu chạy trong terminal. Server đang chạy nền lưu PID trong `.team/state/controller.lock` và log tại `.team/server.log`; có thể dừng đúng PID đó trong Task Manager.

```powershell
npm run demo
node src/server.js --config .team/demo.config.json
```

Demo ở <http://127.0.0.1:3334>, database/repo tách riêng. Nút “Giao việc mới” tạo chu trình mô phỏng trên `hello.txt`. Không dùng demo để đánh giá chất lượng AI thật.

## Đăng nhập 3 Codex

`npm run setup` tạo ba thư mục dưới `%USERPROFILE%\.ai-team\accounts`, mỗi thư mục có `cli_auth_credentials_store = "file"`. Không sao chép token từ tài khoản đang dùng của desktop.

```powershell
.\scripts\login.ps1 codex-1
.\scripts\login.ps1 codex-2
.\scripts\login.ps1 codex-3
```

Mỗi lần chọn đúng tài khoản/workspace trong trình duyệt. Script chỉ đổi `CODEX_HOME` trong lúc login và khôi phục môi trường sau đó. Dashboard đọc account/quota qua protocol CLI chính thức; không tự mở hoặc hiển thị nội dung `auth.json`. Nếu tổ chức áp chính sách workspace, profile vẫn phải tuân theo chính sách đó.

## Google reviewer

Google AI Pro/Ultra cá nhân sử dụng [Antigravity CLI chính thức](https://github.com/google-antigravity/antigravity-cli). Gemini CLI đã cài trên máy là 0.36.0; chưa có `agy` trong PATH lúc kiểm tra. Không tự thay cài đặt Google hoặc đăng nhập thay bạn.

Sau khi cài và đăng nhập `agy`, kiểm tra bản CLI hỗ trợ `agy -p /usage --output-format json` bằng [changelog chính thức](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md). Sau đó đặt `quotaPrintSupported: true` cho agent `gemini` trong `team.config.json`. Cờ này ngăn CLI cũ hiểu `/usage` thành một yêu cầu gọi model.

`command` là mảng executable + arguments. Nếu `agy` không có trong PATH, dùng đường dẫn `.exe` tuyệt đối. Không cấu hình `.cmd`, `.bat`, `.ps1`; dùng executable hoặc `node` + đường dẫn JS để tránh shell xử lý nội dung prompt.

Nếu bạn dùng Gemini Code Assist doanh nghiệp hoặc API, đổi provider thành `gemini` và command thành `["C:/Program Files/nodejs/node.exe", "C:/Users/user/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/gemini.js"]`. Quota của Gemini CLI này chưa được tích hợp: hiển thị UNKNOWN. Cấu hình hiện tại chủ đích dùng đăng nhập subscription và loại API key kế thừa khỏi môi trường worker; đường xác thực bằng API cần cấu hình riêng trước khi dùng.

## Đăng ký repo

Sửa `projects` trong `team.config.json`, rồi khởi động lại server. Ví dụ:

```json
{
  "projects": [{
    "id": "my-app",
    "path": "D:/projects/my-app",
    "tests": [
      ["C:/Program Files/nodejs/node.exe", "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js", "test", "--", "--run"]
    ]
  }]
}
```

Chỉnh lệnh test đúng dự án; ví dụ trên chỉ phù hợp nếu test runner hỗ trợ `--run`. `tests` là danh sách argv do bạn cấu hình, không phải lệnh agent tự gửi. Repo phải có commit và sạch khi tạo công việc. Dependency/build environment của worktree cần sẵn sàng; không tự copy `.env`, credential hoặc `node_modules` từ repo chính. Có thể thêm một bước thiết lập tin cậy vào `tests` nếu dự án cần, ví dụ `npm ci` qua JS entry point.

## Luồng hoạt động

1. Người dùng gửi mục tiêu; controller tạo branch và worktree từ HEAD.
2. Codex 01 đọc repo, trả danh sách việc và chỉ định Codex 02/03.
3. Controller giao từng việc, thu hoạt động/report rồi checkpoint bằng Git.
4. Controller chạy các lệnh `tests`. Nếu thất bại, trả bằng chứng cho manager lập việc sửa.
5. Google reviewer đánh giá commit; findings được đưa vào lần lập kế hoạch tiếp theo.
6. Codex 03 xác minh; Codex 01 tổng hợp báo cáo. Tối đa 3 vòng sửa mặc định.
7. Khi test, review và verify cùng commit, task chuyển READY. Nút merge thực hiện fast-forward local sau khi kiểm tra source branch vẫn ở base ban đầu. Không push remote.

Controller quyết định thứ tự test/review/verify; manager quyết định các task implementation. Timeline ghi đúng nguồn: lệnh do controller sinh được ghi là Controller, nội dung task từ manager được ghi là Manager. Đây là phối hợp qua prompt/report từng lượt; không phải bốn phiên chat thường trực hay hiển thị suy luận nội bộ.

## Điều khiển và giới hạn

- Mặc định một tiến trình agent/test tại một thời điểm cho toàn controller. Tạm hoãn lượt mới khi RAM >85% hoặc CPU >90%. Đây là ngưỡng khởi chạy, không phải giới hạn cứng CPU/RAM của lệnh con; một build đơn lẻ vẫn có thể nặng.
- Pause kết thúc cây tiến trình. Resume gọi lại bước hiện tại với dữ liệu đã lưu, không tiếp tục nội bộ cùng một CLI session. Thay đổi trong worktree được giữ; nên xem diff sau khi dừng giữa chừng.
- Chỉ dẫn mới được nhận ở lần gọi tiếp theo; nếu được gửi giữa một lượt đang chạy, manager sẽ lập lại kế hoạch. Chỉ dẫn sau READY làm mất điều kiện merge cho tới khi kiểm tra lại.
- Sau restart, task đang chạy/queued/merging chuyển PAUSED để người dùng xem lại. Không tự chạy lại thao tác dở dang.
- Worker Codex chạy `workspace-write`, các bước phân tích chạy `read-only`; không dùng cờ bỏ sandbox. Google review dùng detached worktree riêng, mặc định CLI policy. Git worktree không phải sandbox bảo mật; chỉ chạy repo tin cậy và cấu hình permission phù hợp trong CLI.
- Không thể ép các shell tool bên trong CLI chỉ sinh một tiến trình; controller chỉ tuần tự hóa các lượt do nó khởi chạy.
- Quota hết hoặc dưới ngưỡng 15% ngăn giao việc cho tài khoản đó. UNKNOWN không được coi là còn 100%; lỗi quota/CLI đưa task về BLOCKED. Không tự xoay tài khoản để thử lại một lỗi giới hạn. Có thể tạm dừng và đổi builder bằng dashboard.
- Không tự rebase khi base repo đã thay đổi, không tự xóa worktree. Việc này giữ thay đổi để kiểm tra và xử lý xung đột thủ công.
- Nhật ký dùng allowlist sự kiện CLI để bỏ reasoning, có che một số dạng credential phổ biến. Đây không phải DLP hoàn chỉnh; prompt và nội dung source trong log vẫn là dữ liệu riêng tư, không đưa `.team` lên Git.
- Parser quota Google chỉ nhận trường provider xác định được (`remaining_fraction`, `reset_time`). Nếu schema khác, giữ raw response và hiển thị UNKNOWN; cần điều chỉnh theo response thực sau login.

## MCP

Chạy server trước rồi đăng ký MCP stdio với client bạn chọn:

```toml
[mcp_servers.ai_team]
command = "C:/Program Files/nodejs/node.exe"
args = ["D:/work_team/src/mcp.js"]
```

Tools: `team_status`, `delegate_task`, `get_agent_status`, `read_messages`, `send_message`, `control_task`. Không có tool merge: duyệt merge ở dashboard. Chưa tự sửa cấu hình MCP của Codex Desktop hoặc các profile. Không gắn MCP này vào worker đang được controller quản lý để tránh gọi lồng vòng điều phối.

## Kiểm tra

```powershell
npm test
```

Kiểm tra parser/quota, argv không qua shell, timeout tiến trình, pipeline Git thật, chặn thay đổi sau approval, merge có điều kiện, persistence, pause/resume/reassign, test failure và config không hợp lệ. Chưa có bằng chứng chạy AI thật cho tới khi nối tài khoản.

Nghiên cứu và nguồn: [RESEARCH.md](RESEARCH.md).

## Hồ sơ thành viên, giao việc theo độ khó, merge an toàn

**Hồ sơ & prompt** (màn Quota & tài khoản → nút trên từng thẻ):
- *Model*: Codex lấy danh sách thật qua `model/list` của tài khoản đó; Claude/Gemini chưa có lệnh liệt kê nên hiện gợi ý + ô "Khác…" để nhập tay. Để trống = mặc định của CLI.
- *Năng lực*: Mạnh (nhận độ khó 1–5), Bình thường (1–3), Yếu (1–2).
- *System prompt riêng*: gửi kèm mọi lượt gọi member đó, đặt sau quy tắc an toàn hệ thống.
- *Cho phép nhận việc*: tắt để tạm cho nghỉ mà không xóa.
- Mỗi member giữ một vai trò; chọn "Dự bị" để rút khỏi luồng. Đổi vai trò áp dụng cho việc mới và cho việc đang dừng khi bấm Tiếp tục.

**Manager chấm độ khó** theo thang 1–5 (1 sửa chữ/config · 2 nhỏ, cục bộ · 3 tính năng/bug nhiều file · 4 xuyên module, data/API, bảo mật, migration · 5 kiến trúc, mơ hồ, khó đảo ngược; phân vân thì làm tròn lên). Manager nhận bảng builder gồm model, năng lực, quota còn lại và được dặn chọn người *yếu nhất mà vẫn đủ* để giữ quota cho member mạnh. Controller kiểm lại từng task trước khi chạy:
- người được giao không đủ năng lực / dưới ngưỡng quota / đang tắt / đang kiêm Reviewer-Verifier → tự đổi sang người phù hợp, ghi sự kiện `REROUTE`;
- không ai đủ năng lực → giao cho người mạnh nhất còn quota và tự nâng rủi ro merge lên **cao**;
- "Đổi builder" thủ công của bạn luôn được ưu tiên.

**Merge** không bao giờ tự động. Nút Duyệt merge mở bảng kiểm:
- test, review, verify đều phải pass trên *đúng commit* sẽ merge; ai đã viết code trong việc đó không được review/verify chính nó;
- base branch phải chưa đổi. Nếu đã đổi: bấm **Cập nhật theo base** → merge base vào branch việc; không xung đột thì chạy lại test/review/verify, có xung đột thì tạo task gỡ xung đột (độ khó 4) rồi mới đi tiếp. Commit còn conflict marker bị chặn;
- rủi ro cao (Manager đánh giá cao, đụng file nhạy cảm, xóa file, diff > `largeDiffLines` = 300 dòng, hoặc task do người thiếu năng lực làm) → phải gõ mã commit để xác nhận;
- merge chỉ fast-forward vào branch gốc. Tùy chỉnh trong `team.config.json`: `sensitivePaths` (regex), `largeDiffLines`.
