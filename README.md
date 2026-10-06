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

## Phản biện

- **Phản biện kế hoạch**: việc rủi ro cao (strict/high) được một member khác — ưu tiên khác loại CLI với Manager — đọc kế hoạch trước khi ai làm. Tối đa 3 phản đối (nhận định · khi nào sai · bằng chứng · cách kiểm · mức ảnh hưởng); `[]` = không có vấn đề đáng kể. Có phản đối mức medium/high → Manager sửa kế hoạch **một lần**, không phản biện lại.
- **Findings có cấu trúc**: review/verify trả findings có id (F1…) và mức ảnh hưởng. Ở vòng sửa, builder trả lời từng finding: fixed / rejected (phải kèm bằng chứng) / unclear.
- **Tranh chấp**: finding bị builder bác bỏ → sự kiện DISPUTE, verify bị ép chạy (kể cả rigor light/standard) và phải phân xử bằng kiểm tra thực tế (RULING). Bên có bằng chứng thắng, không phải bên nói hay hơn.
- **Không ép đồng thuận**: hết `maxReworkRounds` mà còn finding mức high → job chuyển *chờ bạn quyết* kèm danh sách vấn đề, thay vì để Manager chốt.
- **Flow do Manager đề xuất, Controller chốt**: plan có thể gửi `flow: {reviewer, verifier, steps}`. Không gửi `steps` = quy trình mặc định; `steps: []` = Manager muốn bỏ hết bước AI (test vẫn chạy). Bước Manager bỏ nhưng chốt cố định cần (strict, cổng rủi ro, tranh chấp) bị ép chạy lại → sự kiện OVERRIDE, sơ đồ ghi “bị ép: lý do”. Member Manager chọn không hợp lệ/tắt/hết quota → dùng mặc định và cảnh báo; kiểm lại lúc thực thi chứ không tin giá trị lưu từ lúc lập kế hoạch.
- **Đồ thị công việc do Leader lập**: task có `kind`: `implement` (mặc định) hoặc `review`. Node review xem đúng commit của các task nó phụ thuộc (`base..commit` ghi lại khi task xong), người review độc lập với tác giả các task đó. Review chưa đạt → controller tự tạo task sửa (ưu tiên tác giả cũ, kèm findings) và review lại node đó, tối đa 2 lần; quá 2 lần mới trả về Leader. Ví dụ 4 task → 4 review → test → 1 verify = 4 node implement + 4 node review + `flow.steps: ["verify"]`. Test tích hợp cuối job luôn chạy. Sơ đồ dashboard vẽ theo cột phụ thuộc khi job có node review. Leader không dùng `kind` → quy trình như cũ.
- **Kiểm tra độc lập**: reviewer/verifier trùng người đã viết code trong việc → tự đổi sang member khác (ưu tiên khác loại CLI với builder), sự kiện REROUTE. Không còn ai mới giữ người cũ và bắt gõ mã khi merge như trước.
- **Giới hạn độ dài**: tóm tắt kế hoạch ≤ 2 câu, review ≤ 5 finding, báo cáo cuối khoảng 200–400 từ.
- **Đo hiệu quả**: mỗi việc ghi `metrics` (phản đối kế hoạch, finding, bị bác bỏ, verifier giữ/lật), hiện ở bảng chi tiết task. Sau khoảng 20 việc thật, so sánh với cách chạy 1 builder để biết phản biện có đáng chi phí không.

## Điều khiển và giới hạn

- Mặc định một tiến trình agent/test tại một thời điểm cho toàn controller. Tạm hoãn lượt mới khi RAM >85% hoặc CPU >90%. Đây là ngưỡng khởi chạy, không phải giới hạn cứng CPU/RAM của lệnh con; một build đơn lẻ vẫn có thể nặng.
- Pause kết thúc cây tiến trình. Resume gọi lại bước hiện tại với dữ liệu đã lưu, không tiếp tục nội bộ cùng một CLI session. Thay đổi trong worktree được giữ; nên xem diff sau khi dừng giữa chừng.
- Chỉ dẫn mới được nhận ở lần gọi tiếp theo; nếu được gửi giữa một lượt đang chạy, manager sẽ lập lại kế hoạch. Chỉ dẫn sau READY làm mất điều kiện merge cho tới khi kiểm tra lại.
- Sau restart, task đang chạy/queued/merging chuyển PAUSED để người dùng xem lại. Không tự chạy lại thao tác dở dang.
- Worker Codex chạy `workspace-write`, các bước phân tích chạy `read-only`; không dùng cờ bỏ sandbox. Google review dùng detached worktree riêng, mặc định CLI policy. Git worktree không phải sandbox bảo mật; chỉ chạy repo tin cậy và cấu hình permission phù hợp trong CLI.
- Không thể ép các shell tool bên trong CLI chỉ sinh một tiến trình; controller chỉ tuần tự hóa các lượt do nó khởi chạy.
- Quota hết hoặc dưới ngưỡng 15% ngăn giao việc cho tài khoản đó. UNKNOWN không được coi là còn 100%; Builder chạm giới hạn quota giữa chừng → controller tự bàn giao task cho builder khác đủ năng lực còn quota (sự kiện HANDOVER), kèm diff phần đã làm dở và 20 bước cuối của người trước; builder mới làm tiếp, không làm lại. Không còn ai phù hợp, hoặc lỗi không phải quota → BLOCKED. Không chuyển được ngữ cảnh hội thoại của CLI, chỉ chuyển trạng thái công việc. Vẫn có thể tạm dừng và đổi builder bằng dashboard.
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

**Manager chấm độ khó** theo thang 1–5 (1 sửa chữ/config · 2 nhỏ, cục bộ · 3 tính năng/bug nhiều file · 4 xuyên module, data/API, bảo mật, migration · 5 kiến trúc, mơ hồ, khó đảo ngược; phân vân thì làm tròn lên). Manager nhận bảng builder gồm model, năng lực, quota còn lại; ưu tiên người mạnh khi rảnh. Mỗi task có `estMinutes`, `dependsOn` (chỉ trỏ task đứng trước), `files` và `context` (file:dòng, symbol, bẫy — Lead phân tích một lần, builder không đọc lại cả repo; builder báo `contextGaps` nếu phải tìm thêm). Controller kiểm lại từng task trước khi chạy:
- người được giao không đủ năng lực / dưới ngưỡng quota / đang tắt / đang kiêm Reviewer-Verifier → tự đổi sang người phù hợp, ghi sự kiện `REROUTE`;
- không ai đủ năng lực → giao cho người mạnh nhất còn quota và tự nâng rủi ro merge lên **cao**;
- "Đổi builder" thủ công của bạn luôn được ưu tiên;
- người tốt nhất đang bận → so thời điểm xong (ước lượng × hệ số tốc độ học từ các lượt trước): giao người rảnh làm ngay nếu xong sớm hơn, không thì chờ.

**Chạy song song**: task không phụ thuộc nhau chạy cùng lúc; task code trùng `files` thì không. Nhiều task code song song chạy ở worktree/branch con rồi gộp vào nhánh việc trước khi test (xung đột → BLOCKED kèm danh sách file). Nhiều công việc cũng chạy song song. Số agent chạy cùng lúc tính theo RAM trống (GB), `team.config.json`:
`"resources": { "reserveGB": 4, "ramPerAgentGB": 1.5, "maxAgents": 3, "hardStopRamPercent": 90 }` → thêm agent khi `(RAM trống − reserveGB) / ramPerAgentGB ≥ 1`; RAM ≥ 90% thì không mở agent mới (không dừng agent đang chạy). Mặc định một tài khoản chạy một việc một lúc. Cho chạy song song: `"maxJobsPerAccount": 2` (toàn đội) hoặc `"maxJobs": 2` trên từng agent (tối đa 8). Codex slot 2+ dùng SQLite riêng `<home>/sqlite-N` qua `CODEX_SQLITE_HOME` (đừng đặt `sqlite_home` trong config.toml của profile, nó ghi đè); đăng nhập dùng chung. Nếu `config.toml` của profile hoặc `.codex/config.toml` của project đặt `sqlite_home`, tài khoản đó tự quay về 1 việc (có cảnh báo trong log). Các job dùng chung hạn mức của tài khoản; chạy đồng thời có thể làm hạn mức hết nhanh hơn. Tiến trình đọc quota Codex (`account/rateLimits/read`) dùng SQLite riêng (`<home>/sqlite-quota`) nên vẫn chạy khi tài khoản đang làm việc; nếu phát hiện `sqlite_home` thì hoãn đọc tới khi tài khoản rảnh. SQLite riêng không phải quota riêng. Giới hạn song song tính theo email tài khoản (từ lần đọc quota), nên hai hồ sơ cùng tài khoản dùng chung bộ đếm; chưa đọc được email thì tính theo hồ sơ. Mỗi lần chạy CLI ghi sự kiện SPAWN (PID, slot, thư mục, đường dẫn SQLite). Controller tắt đột ngột mà tiến trình con còn sống: sau khi khởi động lại, slot của nó vẫn bị giữ (tối đa 60 phút) chứ không cấp trùng; controller không tự kill tiến trình đó. Nhiều việc trên cùng project: mỗi việc có branch/worktree riêng; Lead của việc mới được báo các việc đang chạy và file họ dự định sửa để tránh trùng; việc merge sau sẽ phải "Cập nhật theo base".

**Merge** không bao giờ tự động. Nút Duyệt merge mở bảng kiểm:
- test, review, verify đều phải pass trên *đúng commit* sẽ merge; ai đã viết code trong việc đó không được review/verify chính nó;
- base branch phải chưa đổi. Nếu đã đổi: bấm **Cập nhật theo base** → merge base vào branch việc; không xung đột thì chạy lại test/review/verify, có xung đột thì tạo task gỡ xung đột (độ khó 4) rồi mới đi tiếp. Commit còn conflict marker bị chặn;
- rủi ro cao (Manager đánh giá cao, đụng file nhạy cảm, xóa file, diff > `largeDiffLines` = 300 dòng, hoặc task do người thiếu năng lực làm) → phải gõ mã commit để xác nhận;
- merge chỉ fast-forward vào branch gốc. Tùy chỉnh trong `team.config.json`: `sensitivePaths` (regex), `largeDiffLines`.

## Quyền theo dự án và repo sửa cùng

Mỗi project có `access` riêng trong `team.config.json` (sửa ở trang **Quyền & bảo mật**):

```json
"access": {
  "folders": [{ "path": "D:\\w\\FE_NEW\\docs", "members": ["codex-1", "claude-x"], "why": "spec" }],
  "network": ["claude-x"],
  "repos":   [{ "project": "fe-new", "members": ["codex-1"], "why": "API dùng chung" }]
}
```

- `folders`: thư mục ngoài repo, **chỉ đọc**, cấp theo từng member (`"*"` = mọi member). Claude bị chặn thật bằng quyền công cụ; Codex đọc được cả máy trong sandbox nên với Codex đây là chỉ dẫn trong prompt.
- `network`: member được dùng Internet (Codex: sandbox mở mạng; Claude: WebSearch/WebFetch).
- `repos`: project **khác đã đăng ký** được SỬA cùng việc. Mỗi việc tạo worktree + branch `ai-team/<id>` trong từng repo liên kết; chỉ member có tên được ghi (Codex/Claude `--add-dir`, Gemini `--include-directories`; agy chưa hỗ trợ). Test của cả hai project đều chạy; reviewer/verifier thấy diff của từng repo; commit rỗng `linked <repo>@<sha>` trong repo chính làm mọi duyệt cũ mất hiệu lực khi repo liên kết đổi; merge kiểm mọi repo trước rồi mới fast-forward lần lượt. Member không được cấp mà sửa repo liên kết → việc dừng. Giới hạn: repo liên kết đổi base thì chưa có "cập nhật" tự động (hủy và giao lại); việc có repo liên kết chạy task code lần lượt.
- Nút **Leader đề xuất**: Leader đọc repo và các thư mục/dự án ứng viên rồi soạn bản nháp (ít quyền nhất); bạn sửa và bấm **Lưu**. Leader không tự lưu được.
- Cấu hình cũ `readDirs` / `network: true` vẫn chạy (= cấp cho mọi member) và được chuyển sang `access` khi sửa.

## Bộ nhớ AI, sao lưu, xuất

Mỗi lượt gọi CLI là phiên mới (không `--resume`), nên "trí nhớ" của đội nằm trong `team.sqlite`, không phụ thuộc lịch sử của CLI/tài khoản. Có 3 tầng, đều có giới hạn để không phình prompt:

| Tầng | Ai ghi | Ai đọc | Giới hạn |
|---|---|---|---|
| Ghi chú dự án (fact) | Leader ở bước tổng kết: `memory.add` (≤5/lần), `memory.remove` theo id `M<n>` | Leader khi lập kế hoạch/tổng kết; builder chỉ ở đường nhanh | 60 fact/dự án (`maxMemoryFacts`), ~4.000 ký tự vào prompt |
| Tóm tắt phiên | Leader viết lại mỗi lần tổng kết (`memory.session`) | Leader | 1.500 ký tự |
| Nhật ký phiên | Controller, 1 dòng/việc, không tốn AI | Leader (8 dòng gần nhất) | 200 dòng/phiên |

Bộ nhớ được đánh dấu là dữ liệu (không phải chỉ dẫn) và có thể đã cũ: AI phải đối chiếu code. Builder nhận phần liên quan qua `context` của task do Leader soạn. Xem/sửa/xóa ở nút 🧠 trên thanh phiên.

- **Sao lưu**: `VACUUM INTO` vào `backupDir` (mặc định `<dataDir>/backups`), tự động mỗi ngày và trước khi xóa việc/phiên, giữ `backupKeep` bản (14). Tắt bằng `"backup": false`. Khôi phục: dừng server, chép bản sao lưu đè lên `team.sqlite`.
- **Xuất**: nút "Xuất" ở việc → file Markdown (mục tiêu, kế hoạch, báo cáo, trao đổi, diff).

### Codex trên Windows không sandbox (`"codexWindowsSandbox": "none"`)

Chế độ `elevated` bắt Codex chạy `codex-windows-sandbox-setup` (UAC) mỗi khi trạng thái sandbox lệch — với nhiều CODEX_HOME trên cùng máy thì hỏi liên tục (lỗi đang mở của Codex). `"none"` chạy Codex với `--sandbox danger-full-access`: không còn UAC, nhưng Codex có toàn quyền của user Windows (ghi ngoài worktree, có mạng). Controller vẫn kiểm tra worktree/repo liên kết sau mỗi lượt và mọi thay đổi vẫn phải qua test/review/verify và bạn duyệt merge. Quay lại: đặt `"elevated"`.

### Antigravity tự duyệt quyền (`"agyAutoApprove": true`)

agy headless kết thúc phiên ngay khi một lệnh bị từ chối (không có report). Bật tùy chọn này để chạy agy với `--dangerously-skip-permissions`: không còn bị chặn lệnh, đổi lại agy có toàn quyền như Codex `"none"`. Tắt thì agy chỉ chạy được lệnh trong `permissions.allow` của `~/.gemini/antigravity-cli/settings.json` và được dặn chỉ dùng công cụ đọc file.
