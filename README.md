# AI Team Control Room

Dashboard local điều phối một đội AI CLI (Codex, Claude Code, Antigravity/Gemini) trên repo của bạn: Manager lập kế hoạch, Builder làm, Reviewer/Verifier kiểm tra, bạn duyệt merge. Chạy Node.js 24, SQLite có sẵn trong Node và SDK MCP chính thức. Giao diện không cần build, Docker, React hay dịch vụ cloud riêng.

## Trạng thái

- Đã có: hàng đợi, Manager chia việc bằng JSON, task song song trên Git worktree, checkpoint, test thật, review/sửa có giới hạn, verifier, hỏi đồng đội, báo cáo và merge có duyệt; timeline, diff, tạm dừng/hủy/tiếp tục, đổi builder, gửi chỉ dẫn, quota và lịch sử quota.
- Adapter: `codex exec` (+ quota qua app-server), Claude Code, Antigravity `agy` (+ quota), Gemini CLI. Đã chạy job thật với tài khoản thật (code và research); chưa có benchmark chất lượng.
- Demo dùng agent giả được ghi rõ; repo, Git, SQLite, test và điều kiện merge trong demo là thật. Không suy diễn quota từ token.
- Máy mới cần: đăng nhập từng thành viên, đăng ký repo và lệnh test (xem bên dưới).

## Chạy

```powershell
cd D:\work_team
npm ci --ignore-scripts
npm run setup
npm start
```

Mở <http://127.0.0.1:3333>. Chỉ bind loopback; dùng địa chỉ này, không dùng `localhost`. Ctrl+C để dừng nếu chạy trong terminal. Server lưu PID trong `<dataDir>/controller.lock` (mặc định `.team/state/`); khi chạy nền có thể dừng đúng PID đó trong Task Manager. Server ghi log ra stdout/stderr; muốn có file log thì tự chuyển hướng, ví dụ `npm start > .team/server.log 2>&1`.

```powershell
npm run demo
node src/server.js --config .team/demo.config.json
```

Demo ở <http://127.0.0.1:3334>, database/repo tách riêng. Nút “Giao việc mới” tạo chu trình mô phỏng trên `hello.txt`. Không dùng demo để đánh giá chất lượng AI thật.

## Đội hình và vai trò

Mỗi thành viên là một mục trong `agents` (`provider`: `codex` | `claude` | `antigravity` | `gemini`; `home` riêng; `tier`: `strong`/`normal`/`weak`). Vai trò do `pipeline` quyết định:

```json
"pipeline": { "manager": "claude-1", "reviewer": "gemini", "verifier": "codex-2", "builders": ["codex-2", "codex-3", "codex-1"] }
```

Không có `pipeline` thì controller tìm theo trường `kind` của agent, cuối cùng mới dùng mặc định cũ (codex-1 Manager, gemini Reviewer, codex-3 Verifier). Đổi vai trò, thêm/tắt thành viên ở màn **Quota & tài khoản** (＋ Thêm thành viên) — dashboard tự ghi lại `pipeline`. `team.config.example.json` là đội hình mẫu đầy đủ (Claude làm Manager).

`npm run setup` chỉ tạo cấu hình khởi đầu kiểu cũ (3 Codex + Antigravity) khi chưa có `team.config.json`; không ghi đè file đã có. Muốn đội hình như file mẫu thì chép `team.config.example.json` thành `team.config.json` và sửa đường dẫn.

## Đăng nhập

Cách chung: màn **Quota & tài khoản** → **Tài khoản / đăng nhập lại** → **Đăng nhập** trên thẻ từng thành viên (Codex, Claude, Gemini/Antigravity). Mỗi thành viên lưu đăng nhập trong `home` riêng; Antigravity dùng phiên `agy` chung của máy.

Codex cũng có thể đăng nhập bằng script. `npm run setup` tạo thư mục dưới `%USERPROFILE%\.ai-team\accounts`, mỗi thư mục có `cli_auth_credentials_store = "file"`. Không sao chép token từ tài khoản đang dùng của desktop.

```powershell
.\scripts\login.ps1 codex-1
.\scripts\login.ps1 codex-2
.\scripts\login.ps1 codex-3
```

Mỗi lần chọn đúng tài khoản/workspace trong trình duyệt. Script chỉ đổi `CODEX_HOME` trong lúc login và khôi phục môi trường sau đó. Dashboard đọc account/quota qua protocol CLI chính thức; không tự mở hoặc hiển thị nội dung `auth.json`. Nếu tổ chức áp chính sách workspace, profile vẫn phải tuân theo chính sách đó.

## Google reviewer

Google AI Pro/Ultra cá nhân sử dụng [Antigravity CLI chính thức](https://github.com/google-antigravity/antigravity-cli). Controller không tự cài hay đăng nhập Google thay bạn.

Sau khi cài và đăng nhập `agy`, kiểm tra bản CLI hỗ trợ `agy -p /usage --output-format json` bằng [changelog chính thức](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md). Sau đó đặt `quotaPrintSupported: true` cho agent `gemini` trong `team.config.json`. Cờ này ngăn CLI cũ hiểu `/usage` thành một yêu cầu gọi model.

`command` là mảng executable + arguments. Nếu `agy` không có trong PATH, dùng đường dẫn `.exe` tuyệt đối. Không cấu hình `.cmd`, `.bat`, `.ps1`; dùng executable hoặc `node` + đường dẫn JS để tránh shell xử lý nội dung prompt.

Nếu bạn dùng Gemini Code Assist doanh nghiệp hoặc API, đổi provider thành `gemini` và command thành `["C:/Program Files/nodejs/node.exe", "C:/Users/user/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/gemini.js"]`. Quota của Gemini CLI này chưa được tích hợp: hiển thị UNKNOWN. Cấu hình hiện tại chủ đích dùng đăng nhập subscription và loại API key kế thừa khỏi môi trường worker; đường xác thực bằng API cần cấu hình riêng trước khi dùng.

## Đăng ký repo

Dùng **＋ Thêm dự án** trên dashboard, hoặc sửa `projects` trong `team.config.json` rồi khởi động lại server. Ví dụ:

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
2. Manager đọc repo, trả danh sách việc và chỉ định Builder (xem "Hồ sơ thành viên" bên dưới).
3. Controller giao việc (song song nếu không phụ thuộc), thu hoạt động/report rồi checkpoint bằng Git.
4. Controller chạy các lệnh `tests`. Nếu thất bại, trả bằng chứng cho Manager lập việc sửa.
5. Reviewer đánh giá commit; findings được đưa vào lần lập kế hoạch tiếp theo.
6. Verifier xác minh; Manager tổng hợp báo cáo. Tối đa `maxReworkRounds` vòng sửa (mặc định 3).
7. Khi test, review và verify cùng commit, task chuyển READY. Nút merge thực hiện fast-forward local sau khi kiểm tra source branch vẫn ở base ban đầu. Không push remote.

Việc `research` (điều tra, đánh giá, không sửa code) đi cùng luồng nhưng kết thúc bằng kết luận thay vì merge.

Controller quyết định thứ tự test/review/verify; manager quyết định các task implementation. Timeline ghi đúng nguồn: lệnh do controller sinh được ghi là Controller, nội dung task từ manager được ghi là Manager. Đây là phối hợp qua prompt/report từng lượt; không phải bốn phiên chat thường trực hay hiển thị suy luận nội bộ.

## Phản biện

- **Phản biện kế hoạch**: việc rủi ro cao (strict/high) được một member khác — ưu tiên khác loại CLI với Manager — đọc kế hoạch trước khi ai làm. Tối đa 3 phản đối (nhận định · khi nào sai · bằng chứng · cách kiểm · mức ảnh hưởng); `[]` = không có vấn đề đáng kể. Có phản đối mức medium/high → Manager sửa kế hoạch **một lần**, không phản biện lại.
- **Findings có cấu trúc**: review/verify trả findings có id (F1…) và mức ảnh hưởng. Ở vòng sửa, builder trả lời từng finding: fixed / rejected (phải kèm bằng chứng) / unclear.
- **Tranh chấp**: finding bị builder bác bỏ → sự kiện DISPUTE, verify bị ép chạy (kể cả rigor light/standard) và phải phân xử bằng kiểm tra thực tế (RULING). Bên có bằng chứng thắng, không phải bên nói hay hơn.
- **Không ép đồng thuận**: hết `maxReworkRounds` mà còn finding mức high → job chuyển *chờ bạn quyết* kèm danh sách vấn đề, thay vì để Manager chốt.
- **Flow do Manager đề xuất, Controller chốt**: plan có thể gửi `flow: {reviewer, verifier, steps}`. Không gửi `steps` = quy trình mặc định; `steps: []` = Manager muốn bỏ hết bước AI (test vẫn chạy). Bước Manager bỏ nhưng chốt cố định cần (strict, cổng rủi ro, tranh chấp) bị ép chạy lại → sự kiện OVERRIDE, sơ đồ ghi “bị ép: lý do”. Member Manager chọn không hợp lệ/tắt/hết quota → dùng mặc định và cảnh báo; kiểm lại lúc thực thi chứ không tin giá trị lưu từ lúc lập kế hoạch.
- **Đồ thị công việc do Leader lập**: task có `kind`: `implement` (mặc định) hoặc `review`. Node review xem đúng commit của các task nó phụ thuộc (`base..commit` ghi lại khi task xong), người review độc lập với tác giả các task đó. Review chưa đạt → controller tự tạo task sửa (ưu tiên tác giả cũ, kèm findings) và review lại node đó, tối đa 2 lần; quá 2 lần mới trả về Leader. Ví dụ 4 task → 4 review → test → 1 verify = 4 node implement + 4 node review + `flow.steps: ["verify"]`. Test tích hợp cuối job luôn chạy. Sơ đồ dashboard vẽ theo cột phụ thuộc khi job có node review. Leader không dùng `kind` → quy trình như cũ.
- **Kiểm tra độc lập**: reviewer/verifier trùng người đã viết code trong việc → tự đổi sang member khác (ưu tiên khác loại CLI với builder), sự kiện REROUTE. Không còn ai mới giữ người cũ và bắt gõ mã khi merge như trước.
- **Giới hạn độ dài**: tóm tắt kế hoạch ≤ 2 câu, phản biện ≤ 3 phản đối; prompt yêu cầu báo cáo ngắn gọn.
- **Đo hiệu quả**: mỗi việc ghi `metrics` (phản đối kế hoạch, finding, bị bác bỏ, verifier giữ/lật), hiện ở bảng chi tiết task. Sau khoảng 20 việc thật, so sánh với cách chạy 1 builder để biết phản biện có đáng chi phí không.

## Hỏi đồng đội theo vấn đề

Agent có thể hỏi một thành viên khác trong roster của job khi một giả định cần người khác xác nhận. Trao đổi đi qua chính report JSON; không thêm framework, không chia sẻ phiên CLI. Tham khảo: [Claude Agent Teams](https://code.claude.com/docs/en/agent-teams) (experimental, theo tài liệu lúc viết chưa tạo teammate ở chế độ `-p`; kiểm lại khi nâng cấp CLI), [AutoGen Group Chat](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html).

**Bật/tắt và phạm vi**
- Mặc định hỏi trực tiếp; `"peerDialogue": false` để tắt toàn đội. Khi giao việc, chọn `dialogueMode`: `direct`, `independent` hoặc `off`.
- Stage được hỏi: `plan`, `implement`, `research`, `review`, `verify`, `challenge` (không có `final`).
- Chỉ hỏi thành viên khác trong roster của job; không tự tạo agent, đổi task hay cấp quyền.

**Luồng**
1. A trả `status: "waiting_for_reply"` kèm `peerRequest` và checkpoint phần làm dở. CLI của A kết thúc, nhả slot.
2. Controller lưu câu hỏi, chạy B ở stage `consult` trên một worktree tạm (snapshot gồm cả code A đang sửa dở và file mới). Worktree tạm bị xóa sau lượt, nên B có sửa gì cũng không ảnh hưởng tới A.
3. Controller lưu câu trả lời rồi gọi lại A. A phải trả `dialogueDecision`; cần hỏi tiếp thì gửi `peerRequest` với cùng `thread`.
4. Với `independent`, B phân tích task trên snapshot riêng ở bước `assess` **trước khi** nhận claim/câu hỏi/kết luận của A. B không nhận memory, report, transcript hay công cụ memory ở lượt này. Khi có câu hỏi, thêm một lượt CLI so với `direct`; phân tích đã lưu được dùng lại nếu nội dung nguồn chưa đổi. Đây là độc lập về ngữ cảnh trao đổi, cùng code/mục tiêu và model vẫn có thể gây lỗi tương quan.

```jsonc
// A hỏi
{ "status": "waiting_for_reply",
  "peerRequest": { "to": "codex-3", "thread": "D-xxxx /* chỉ khi hỏi tiếp */", "topic": "...", "claim": "...", "question": "...", "evidence": ["file:dòng"] } }
// B trả lời — "disagree" bắt buộc có evidence
{ "status": "completed", "stance": "answer|agree|disagree|unresolved", "answer": "...", "evidence": ["..."] }
// A quyết định — "rejected" bắt buộc có evidence
{ "dialogueDecision": { "thread": "D-xxxx", "outcome": "accepted|rejected|unresolved", "reason": "...", "evidence": ["..."] } }
```

**Quyền và giới hạn**
- Quyền của B = phần giao quyền thư mục tham chiếu, shell, network của A và B, trong trần vai trò hiện tại của mỗi bên (`roleCaps`); `assess` và `consult` đều chỉ đọc.
- B được dặn chỉ đọc, không chạy test/build. Ràng buộc thật là prompt + worktree tạm + sandbox `read-only` của Codex. **Khi bật `"codexWindowsSandbox": "none"` (hoặc `"agyAutoApprove": true`), B vẫn chạy được lệnh và ghi được ngoài worktree** — xem hai mục cuối README.
- Tối đa **2 lượt/vấn đề, 8 lượt/job**. Câu hỏi/trả lời tối đa 2.000 ký tự, evidence tối đa 6 mục × 500 ký tự; lọc secret như report thường.
- Chưa giải quyết, hết lượt hoặc B không chạy được (kể cả hết quota) → lưu checkpoint, task giữ trạng thái chưa xong, job chuyển *chờ bạn trả lời*. Trả lời ở ô câu hỏi của job; A làm tiếp đúng bước đang dở.
- Pause/restart giữ câu hỏi/trả lời đã lưu; lượt CLI đang chạy dở có thể bị chạy lại.

**Chi phí và đo lường**
- Không có câu hỏi thì không thêm lượt CLI. Mỗi câu hỏi tốn **ít nhất 2 lượt** (B trả lời + gọi lại A); prompt các stage trên luôn kèm thêm hướng dẫn hỏi đồng đội.
- Mỗi vấn đề có mã `D`, nhận định `C`, tin nhắn `M`, bằng chứng `E`; `replyTo` nối câu trả lời với đúng tin nhắn, `claimIds` xác định nhận định được trả lời. Thiếu ID ở report cũ được quy về câu hỏi đang chờ; ID sai bị từ chối. `claims: [{statement}]` thêm tối đa 4 nhận định/lượt, 12/vấn đề; quyết định phải xử lý hết nhận định và `remaining` trước khi đóng.
- `dialogueDecision` giữ `choice`, `reason`, `conditions`, `remaining` và `evidenceIds`. Điều kiện dạng văn bản để người/agent kiểm tra, không tự suy diễn thành điều kiện máy chạy. Citation do AI nêu không chứng minh controller đã chạy lệnh; kết quả lệnh test thật nằm trong `checkResults` và timeline.
- Fingerprint tính nội dung file (kể cả file mới/xóa), giữ hiệu lực qua checkpoint/cherry-pick. `peerRequest.files` hoặc `task.files` là phạm vi, thiếu thì xét toàn repo; repo liên kết luôn được xét. File liên quan đổi làm evidence cũ mất hiệu lực và mở lại quyết định; không được hoàn tất/merge khi còn nghĩa vụ. `historical` chỉ cho quyết định plan/challenge độc lập với code. Trích dẫn web chưa có kiểm tra thay đổi tự động. Evidence/decision mới có thể kết luận lại sau khi kiểm chứng; không được viện dẫn E đã cũ.
- Pause/restart và đổi builder giữ quyền sở hữu, câu hỏi đã lưu, lời đáp và nghĩa vụ. Chuyển máy xuất cả nghĩa vụ đang mở. Máy đích phải gán chúng vào task/người nhận hiện tại bằng **Gán / xem lại vấn đề**, hoặc ghi kết luận của bạn kèm bằng chứng. Manager lập kế hoạch rồi chờ gán; không chạy lại lệnh hay quyền từ máy cũ. Đối thoại không tự thành fact trong memory và vẫn qua các cổng test/review/verify/merge.
- **So sánh cùng ngân sách** tạo ba job tạm dừng (`off`, `direct`, `independent`) với cùng base, mục tiêu, file đính kèm, thành viên/model/quyền và trần token/lượt gọi. Cần nhập cả hai trần. Chạy từng job bằng **Tiếp tục**; config đổi thì phải tạo bộ mới, ngân sách đối chiếu không tự mở rộng. API: `POST /api/comparisons` với đầu vào tạo job và `tokenBudget`, `callBudget`. Token được kiểm giữa các lượt CLI nên một lượt có thể vượt trần; so usage thật, không coi trần bằng nhau là số token thực tế bằng nhau. Kế hoạch do model tạo có thể khác giữa các job; đây là công cụ thu thập số liệu, chưa phải benchmark chứng minh chế độ nào tốt hơn.
- **Chấm nhận định** tách đúng/sai khỏi chấp nhận/bác bỏ: bạn ghi lựa chọn trước/sau đúng, sai hoặc chưa đủ bằng chứng, kèm đối chứng. Bảng đối chiếu đếm riêng sai→đúng, đúng→sai và chưa chấm; không dùng confidence hay đồng thuận của AI làm nhãn đúng. Metrics vận hành vẫn giữ số câu hỏi/trả lời, issue đóng, lượt/token. Chưa có đánh giá chất lượng với AI thật.

## Điều khiển và giới hạn

- Controller giới hạn các lượt agent theo `resources.maxAgents` (mặc định 3) và RAM còn trống; task độc lập có thể chạy song song. Tạm hoãn lượt mới khi CPU > `maxCpuPercent` (90) hoặc chạm ngưỡng RAM (`resources.hardStopRamPercent`, mặc định 90; `maxRamPercent` cũ chỉ còn tác dụng nếu > 90). Đây là ngưỡng khởi chạy, không phải giới hạn cứng CPU/RAM của lệnh con; một build đơn lẻ vẫn có thể nặng.
- `maxTokensPerJob` (không đặt = không giới hạn): job dùng hết ngân sách token thì dừng chờ bạn; bấm tiếp tục để cấp thêm một lần ngân sách.
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
  "repos":   [{ "project": "fe-new", "members": ["codex-1"], "why": "API dùng chung" }],
  "paths":   [{ "path": "src", "grant": { "*": "read", "codex-2": "delete", "codex-3": "edit" } },
              { "path": "test", "grant": { "*": "read" } }],
  "shell":   ["*"]
}
```

- `paths`: thư mục **trong repo**, mức quyền riêng từng AI: `read` (xem), `edit` (tạo/sửa, không xóa/đổi tên), `delete` (mọi thứ). Dòng cụ thể hơn thắng (`src/gen` thắng `src`); member cụ thể thắng `"*"`; thư mục không có dòng nào = theo vai trò. Sau mỗi lượt Builder, controller so mọi file đổi (kể cả commit, file mới, xóa) với quyền: file vi phạm bị **hoàn tác đúng file đó** và việc dừng (event `PERMISSION`). Áp dụng cho mọi CLI vì kiểm bằng git, không phụ thuộc sandbox.
- `shell`: member được chạy lệnh. Claude/Gemini/agy gọi lệnh khi không được phép → dừng ngay; Codex đọc file bằng lệnh nên chỉ nhắc trong prompt. Reviewer/Verifier không được chạy lệnh thì không nhận lệnh check.
- **Quyền theo phiên**: mỗi phiên có thể có bộ `access` riêng (lưu trong SQLite, chọn phiên ở ô "Mặc định của dự án / Phiên: …"); việc trong phiên đó dùng bộ riêng thay cho mặc định dự án. "Bỏ quyền riêng" để quay về mặc định.
- **Trần theo vai trò** (`"roleCaps"`, bảng "Ai được làm gì"): tắt chạy lệnh / Internet cho Manager/Builder/Reviewer/Verifier, hoặc tắt xóa file cho Builder. Quyền thực tế = trần của vai trò ở bước đó ∧ quyền cấp cho AI. Commit, merge, push, đọc biến bí mật, ghi ngoài worktree là bất biến, không sửa được.

- `folders`: thư mục ngoài repo, **chỉ đọc**, cấp theo từng member (`"*"` = mọi member). Claude bị chặn thật bằng quyền công cụ; Codex đọc được cả máy trong sandbox nên với Codex đây là chỉ dẫn trong prompt.
- `network`: member được dùng Internet (Codex: sandbox mở mạng; Claude: WebSearch/WebFetch).
- `repos`: project **khác đã đăng ký** được SỬA cùng việc. Mỗi việc tạo worktree + branch `ai-team/<id>` trong từng repo liên kết; chỉ member có tên được ghi (Codex/Claude `--add-dir`, Gemini `--include-directories`; agy chưa hỗ trợ). Test của cả hai project đều chạy; reviewer/verifier thấy diff của từng repo; commit rỗng `linked <repo>@<sha>` trong repo chính làm mọi duyệt cũ mất hiệu lực khi repo liên kết đổi; merge kiểm mọi repo trước rồi mới fast-forward lần lượt. Member không được cấp mà sửa repo liên kết → việc dừng. Giới hạn: repo liên kết đổi base thì chưa có "cập nhật" tự động (hủy và giao lại); việc có repo liên kết chạy task code lần lượt.
- Nút **Leader đề xuất**: Leader đọc repo và các thư mục/dự án ứng viên rồi soạn bản nháp (ít quyền nhất); bạn sửa và bấm **Lưu**. Leader không tự lưu được.
- Cấu hình cũ `readDirs` / `network: true` vẫn chạy (= cấp cho mọi member) và được chuyển sang `access` khi sửa.

## Bộ nhớ AI, sao lưu, xuất

Trí nhớ dùng chung nằm trong `team.sqlite`. Kho giữ lịch sử đầy đủ; controller tìm bằng SQLite FTS5 theo nhiệm vụ và chỉ cấp phần liên quan vào prompt. Không cần thêm database hay embedding model.

| Tầng | Ai ghi | Ai đọc | Giới hạn |
|---|---|---|---|
| Ghi chú dự án (fact) | Leader ở bước tổng kết: `memory.add` (≤5/lần), `memory.remove` theo id `M<n>`; bạn cũng sửa được | Mỗi vai nhận phần liên quan đến task | `maxMemoryFacts` (mặc định 60) và ~4.000 ký tự vào prompt; không xóa fact cũ để giữ giới hạn này |
| Tóm tắt phiên | Leader viết lại mỗi lần tổng kết (`memory.session`) | Leader | 1.500 ký tự |
| Nhật ký phiên | Controller, 1 dòng/việc, không tốn AI | Leader (8 dòng gần nhất) | ~1.500 ký tự vào prompt; giữ lịch sử trong kho |
| Checkpoint task | Worker báo đã làm, còn thiếu, thử thất bại, bước tiếp theo; controller lưu snapshot Git và tests | Worker khi tiếp tục; Manager khi nhận gói chuyển công việc | Giới hạn kích thước từng trường |

Bộ nhớ là dữ liệu, AI vẫn phải đối chiếu nguồn với code. Fact do một job code tạo chỉ dùng trong job đó; sau khi merge mới chia sẻ toàn dự án. Fact mới từ job có nguồn, commit, fingerprint các file đã đổi/được task khai báo, trạng thái và revision. Tìm kiếm loại fact từ commit không thuộc lịch sử worktree hoặc file nguồn đã đổi, kể cả sửa chưa commit. Ghi chú cũ được giữ lại với nguồn `legacy`; quyết định bạn nhập tay không phụ thuộc commit. Xóa ghi chú chuyển nó sang `superseded`, giữ lịch sử; sửa đồng thời phải tải lại revision mới.

Codex và Claude có thêm hai công cụ MCP `team_memory.memory_search` / `memory_get` để lấy thêm ghi chú. Kết nối chỉ đọc, gắn với project/job/worktree của lượt gọi và hết hạn khi lượt kết thúc. Các CLI khác nhận gói ngữ cảnh đã chọn. Xem nguồn, tìm, thêm, bỏ ghi chú hoặc bật lịch sử ở nút 🧠 trên thanh phiên.

Mặc định CLI vẫn mở phiên mới. Có thể thử `"resumeCodexTasks": true` trong cấu hình: Codex dùng `exec resume` khi tiếp tục cùng task implement, cùng tài khoản/profile, worktree, slot và quyền. Đổi các điều kiện đó sẽ mở phiên mới; review/verify luôn có ngữ cảnh riêng. Đây là tối ưu thử nghiệm, không chuyển phiên CLI giữa máy hoặc tài khoản.

- **Sao lưu**: `VACUUM INTO` vào `backupDir` (mặc định `<dataDir>/backups`), tự động mỗi ngày và trước khi xóa việc/phiên, giữ `backupKeep` bản (14). Tắt bằng `"backup": false`. Khôi phục: dừng server, chép bản sao lưu đè lên `team.sqlite`.
- **Xuất**: nút "Xuất" ở việc → file Markdown (mục tiêu, kế hoạch, báo cáo, trao đổi, diff).
- **Xuất/nhập memory**: trong 🧠, tải JSON chứa các fact và lịch sử, rồi nhập vào dự án trên máy khác. UID giúp tránh trùng; xung đột được đếm và giữ bản hiện có. Ghi chú riêng của job thiếu job tương ứng được đánh dấu `stale`. Gói này không chứa lịch sử CLI, tóm tắt phiên hoặc cấu hình tài khoản.
- **Chuyển việc đang làm**: tạm dừng việc, bấm "Chuyển máy" để xuất JSON gồm Git bundle, file sửa dở (cả binary/file mới/xóa), checkpoint, báo cáo và memory. Máy đích cần repo ở đúng base commit; nhập JSON qua 🧠. Job mới được tạo ở trạng thái tạm dừng, Manager kiểm tra code và lập kế hoạch tiếp; tests/review/duyệt cũ không được dùng để merge. Bundle và file sửa dở mỗi loại tối đa 50 MiB; hiện hỗ trợ một repo. Gói không xuất đăng nhập/quyền/phiên CLI; các đường dẫn credential thông dụng bị từ chối cả trong lịch sử Git. Gói vẫn chứa code và lịch sử repo, nên chỉ chia sẻ với nơi được phép nhận code đó.

### Codex trên Windows không sandbox (`"codexWindowsSandbox": "none"`)

Chế độ `elevated` bắt Codex chạy `codex-windows-sandbox-setup` (UAC) mỗi khi trạng thái sandbox lệch — với nhiều CODEX_HOME trên cùng máy thì hỏi liên tục (lỗi đang mở của Codex). `"none"` chạy Codex với `--sandbox danger-full-access`: không còn UAC, nhưng Codex có toàn quyền của user Windows (ghi ngoài worktree, có mạng). Controller vẫn kiểm tra worktree/repo liên kết sau mỗi lượt và mọi thay đổi vẫn phải qua test/review/verify và bạn duyệt merge. Quay lại: đặt `"elevated"`.

### Antigravity tự duyệt quyền (`"agyAutoApprove": true`)

agy headless kết thúc phiên ngay khi một lệnh bị từ chối (không có report). Bật tùy chọn này để chạy agy với `--dangerously-skip-permissions`: không còn bị chặn lệnh, đổi lại agy có toàn quyền như Codex `"none"`. Tắt thì agy chỉ chạy được lệnh trong `permissions.allow` của `~/.gemini/antigravity-cli/settings.json` và được dặn chỉ dùng công cụ đọc file.

## Kiểm tra

```powershell
npm test
```

Kiểm tra parser/quota, argv không qua shell, timeout tiến trình, pipeline Git thật, chặn thay đổi sau approval, merge có điều kiện, persistence, pause/resume/reassign, test failure và config không hợp lệ. Test dùng agent giả; chất lượng AI thật chỉ đánh giá được qua job thật.

Nghiên cứu và nguồn: [RESEARCH.md](RESEARCH.md).
