# Thiết kế luồng dev + RC cho AI Team Control Room

Tài liệu triển khai quyết định dev + RC của owner ngày 16/10/2026: controller tự tích hợp thay đổi đủ điều kiện vào `dev`; owner nghiệm thu một RC cố định rồi cho phép nâng `master` tới đúng RC đó. Không duyệt merge từng job thông thường. Đây là thiết kế và kế hoạch chuyển đổi, chưa phải bằng chứng tính năng đã chạy và chưa cho phép bật tự động.

Quy ước dẫn chứng: HEAD nhánh cha hiện là `cf5f1d90feda6115202ecc04a9a817d3b59006fd`, đã chứa A và tài liệu này. `ca01d50:file:dòng` là dẫn chứng nền lịch sử tại `ca01d504d416f3e2376035013ba87e90aa9100a6`, không phải số dòng HEAD hiện tại; `f9d6a03` là tip đã kiểm kê của `ai-team/52165d13`; `da4a819` là dẫn chứng lịch sử của 299a7e4d, còn tip được context cung cấp là `9b9a1cc5` (merge hai cha `da4a819` và `d05f189`). `b782659` chỉ là checkpoint lịch sử của A, không còn là đầu ra tương lai. Mọi trạng thái/cấu trúc ghi **đề xuất** bên dưới là yêu cầu mới, không khẳng định đã tồn tại trong code. Trạng thái job lấy từ context; Git chỉ chứng minh nhánh, lịch sử và nội dung, không chứng minh scheduler đang chạy phiên bản nào.

## 1. Kiểm kê chỉ đọc và đánh giá hàng đợi 52165d13

### Phạm vi và độ mới của kiểm kê

Chỉ đọc Git và file nguồn cần đối chiếu từ worktree được giao; không mở database, không truy cập dataDir thật, không gọi cổng 3333, không khởi động server, không đọc credential. Lượt cập nhật này dùng `git for-each-ref`, `git rev-parse`, `git show`, `git log -1`, `git diff --stat/--shortstat/--name-only` và đọc diff/source; không khảo sát PID hay worktree để suy ra job đang chạy. Kiểm kê worktree/lịch sử từ lượt trước chỉ có giá trị lịch sử.

Snapshot được giao: HEAD `cf5f1d9`, master `d05f189`, 299a7e4d `9b9a1cc5`, 52165d13 `f9d6a03`. Khi đối chiếu Git ngày 16/10/2026, HEAD và queue vẫn đúng, nhưng ref `master` đã trỏ `9b9a1cc5` và không còn ref riêng `ai-team/299a7e4d`. Vì vậy mọi số liệu trong bảng dùng **mốc cố định `d05f189...<commit>`**, không gọi là diff với master hiện tại; `d05f189...9b9a1cc5` còn 7 file +171/-1, còn `master...9b9a1cc5` tại quan sát này rỗng. Điều này chỉ chứng minh ref/code, không đủ xác nhận thao tác controller, trạng thái job hay runtime. Quyết định bàn giao vẫn giữ 299a7e4d chưa merge/chưa hủy, không tự đổi trạng thái; controller phải đối soát chênh lệch này trước migration. Bằng chứng lượt cập nhật lưu tại `.ai-team/evidence/integration-flow-refresh/` (không commit); không coi tên file evidence cũ là bằng chứng mới.

| Job | Trạng thái theo context; đối chiếu Git | Nhánh / commit quan sát | File đụng, theo diff Git hoặc context khi thiếu ref | Phụ thuộc / giao nhau | Đề xuất chuyển đổi |
| --- | --- | --- | --- | --- | --- |
| 299a7e4d | thuộc otherJobs; ready theo kiểm kê cũ, runtime chưa cung cấp; có chênh lệch ref nêu trên | context: `9b9a1cc5`; Git: commit còn, ref riêng không còn, master trỏ commit này | `public/{app.js,index.html,style.css}`, `locales/{vi,ja,en}.json`, `test/merge-resync-ui.test.js`; 7 file +171/-1 | cùng popup với 8ef4161e; không phải điều kiện tiên quyết B | Chưa merge/chưa hủy theo quyết định owner; controller đối soát trước thao tác; phần báo lỗi còn trong diff cố định, xem mục 2 |
| 2b699046 | ready | `ai-team/2b699046` / `6cfedfd` | taskContext nêu `src/prompts.js`; diff nhánh cộng dồn còn có `src/{team,server}.js`, UI, locale, `scripts/prompt-sizes.js`, test, AGENTS; 13 file | lịch sử chứa 72474809; không coi toàn bộ 751 dòng thêm là phần riêng của task prompt | Giữ; xác định delta riêng với base mới rồi đổi đích dev; thay đổi prompt không được làm yếu cổng controller |
| 1b0e8c0c | blocked | `ai-team/1b0e8c0c` / `d0c4f5e` | `src/{team,capabilities}.js`, UI, locale, `test/system.test.js`; 8 file | đụng vùng điều phối và UI; cần xét nhạy cảm trước dev | Giữ checkpoint; phân loại nguyên nhân blocked, giải quyết phần có bằng chứng rồi đổi đích dev |
| 9ea245a7 | blocked | `ai-team/9ea245a7` / `5fac24a` | 27 file: token UI/chart/vendor, locale, `src/{preview,providers,server,team,usage,usage-pricing}.js`, các test token/usage/provider/system | phạm vi thực tế rộng hơn “token UI tests”; giao preview/providers và B | Giữ; tách đánh giá code nền kế thừa với phần riêng, không tự xếp ít rủi ro; đổi đích sau gate |
| 8ef4161e | blocked | `ai-team/8ef4161e` / `2c253d5` | `public/{app.js,index.html}`, locale, `package.json`, `src/mcp.js`, `test/{merge-sync,system}.test.js`; 9 file | lịch sử merge 69a6b477; cùng popup với 299a7e4d | Giữ trong chuyển đổi; đồng bộ master bị thay thế sau B; chỉ giữ UX lỗi còn cần thiết, không xây thêm queue |
| b1de9072 | blocked | `ai-team/b1de9072` / `551e498` | `public/{app.js,style.css}`, locale, `test/quota-banner.test.js`; 6 file | giao app/locale; chẩn đoán test không phụ thuộc B về chức năng | Giữ, sửa đúng lỗi kiểm thử; khi cơ chế mới hoạt động thì đổi đích dev |
| 52165d13 | blocked | `ai-team/52165d13` / `f9d6a03` | 11 file: `src/{team,server,preview}.js`, UI, locale, `test/{merge-queue,system}.test.js`; team +209, queue test 309 dòng | dựa trên base cũ; giao team/preview với nhiều job; B tái dùng chính job này | Đổi mục tiêu sang hàng đợi tích hợp dev; giữ phần chứng minh được, viết lại điều kiện đích/approval/candidate, không tạo queue thứ hai |

Bảng bao phủ đủ bảy otherJobs được cung cấp. Các nhãn ready/blocked của sáu job còn ref là trạng thái context kiểm kê trước, không phải xác minh runtime mới; lượt này đã kiểm Git tip, danh sách file và số liệu diff từng job. Cột giao nhau là quan hệ code, không xác nhận `dependsOn` vận hành. Runtime, child-process ownership, lock/lease, scheduler version và dependency đang hiệu lực của **từng job** chưa được cung cấp; không suy ra từ PID node hoặc sự tồn tại worktree.

Ngoài danh sách hiện tại, `d1848fb6`, `69a6b477`, `72474809`, `7d6316fc`, `02292acf`, `a6ecd832`, `6eed2b27` chỉ là tham chiếu **lịch sử/chưa xác minh trạng thái hiện tại**. Kiểm kê trước ghi checkpoint cleanup `d05f189` của d1848fb6 và code nền/semaphore từ các job cũ; không coi chúng là job chưa xong hiện tại hay đề nghị hủy/merge tự động. Các ref khác `1b3d9793`, `54e46bff`, `95d9c0cd`, `bfe0366d`, `c3eb9e3b`, `d863d4cc`, `f9b201df`, `fd485361` có trong Git nhưng không có trạng thái context; cũng không gán đang chạy/đã xong.

A và tài liệu đã có trong nhánh cha `cf5f1d9`: `src/team.js:763–790` có summary phân trang/detail, `src/server.js:173–178` có route, `src/mcp.js:20–28` có `team_status`/`job_detail`, `test/status-api.test.js` có 212 dòng. Đây là kiểm tra sự hiện diện mã, chưa phải kết quả nghiệm thu API. Không tạo lại A hoặc chờ nhánh task A như đầu ra tương lai. **Ranh giới bàn giao trước migration:** controller nghiệm thu A, rồi cung cấp inventory vận hành mới qua API đó, gồm mọi job chưa xong, revision/base/đích, trạng thái/nextAction, và đối chiếu bổ sung runtime/tiến trình sở hữu/lock/phụ thuộc mà API chưa biểu diễn. Tài liệu chỉ cung cấp kiểm kê Git; thiếu inventory vận hành thì chưa đủ điều kiện migration/bật tự động.

### Những gì 52165d13 đã làm và những gì còn thiếu

Không có literal `master` làm đích trong lõi queue đã đọc: đích được lấy từ `job.baseBranch`. Tuy nhiên “base lúc tạo job cũng là đích merge” vẫn là giả định cứng. Nền hiện chọn base mặc định từ nhánh checkout (`ca01d50:src/team.js:814`), `mergeTarget` chọn `job.baseBranch` cho target `base` (`ca01d50:src/team.js:2735`), `mergeCheck.baseUnchanged` đòi head bằng `job.base` (`ca01d50:src/team.js:2772`, `ca01d50:src/team.js:2784`), và `merge` chặn nếu base đổi (`ca01d50:src/team.js:2798`). Chỉ thay chuỗi master thành dev sẽ giữ nguyên vòng đồng bộ/chờ duyệt từng job; không đủ cho thiết kế mới.

| Phần hiện có, dẫn chứng ở f9d6a03 | Tái dùng cho dev | Phần phải đổi / viết lại |
| --- | --- | --- |
| `save(...,{queue:true})` giữ trường queue từ snapshot mới (`f9d6a03:src/team.js:595`) | ý tưởng bảo vệ thao tác hủy khỏi stale save | chuyển queue/operation thành record riêng có version; bảo vệ cả enqueue, cancel, policy, candidate và restart; không thay thế nguyên hàm save mới ở snapshot |
| `processMergeQueue`, cờ busy và chọn đầu hàng theo project + baseBranch (`f9d6a03:src/team.js:1897`) | FIFO, đặt chỗ trước xử lý, kiểm tra lại sau await | khóa theo Git common-dir chuẩn hóa của repo, không theo projectId/baseBranch; hai project cùng repo vẫn chỉ một lượt; thêm lease bền và epoch cấu hình |
| so tip với base rồi `syncJob` hoặc `doMerge` (`f9d6a03:src/team.js:1906`) | phát hiện base đi tiếp | thay bằng bản kết hợp riêng từ dev hiện tại, không sửa worktree đang code; kiểm tra candidate kể cả task base chưa đổi |
| enqueue lưu `approved.revision/risk/sensitive/deleted`, yêu cầu acceptance (`f9d6a03:src/team.js:2058`) | giữ nguồn gốc revision và kiểm tra rủi ro | job thường đủ điều kiện tự xếp hàng, không cần owner duyệt job; nhóm nhạy cảm vẫn duyệt trước dev; approval RC là record khác, không dùng “duyệt một lần cho cả job” |
| sync ghi `syncedRevision/syncedTree`, chặn code thêm ngoài checkpoint (`f9d6a03:src/team.js:2198`, `f9d6a03:src/team.js:2224`) | kiểm tra HEAD/tree/dirty chống sửa sau test | lưu tuple taskRevision/devBase/candidateCommit/tree/policyHash; task sửa phải tạo candidate khác và chạy lại gate |
| conflict abort, fail check thì stop/pause (`f9d6a03:src/team.js:2215`, `f9d6a03:src/team.js:1892`) | giữ bằng chứng conflict, không tự sửa khi chưa biết nguyên nhân | phân loại lỗi ở mục 5; dev đổi chỉ chuẩn bị lại; code/conflict có đường riêng, không gom mọi lỗi thành rework hoặc bắt owner duyệt lại job thường |
| queue chỉ ff/update-ref, từ chối pending merge hoặc mode merge (`f9d6a03:src/team.js:2363`) | bất biến ref chỉ nhận commit đã kiểm | không dùng nguyên đường này: dựng merge candidate bên ngoài rồi kiểm, cuối cùng CAS dev; không yêu cầu owner duyệt merge commit của từng job thường |
| detached merge candidate + `runTests` + pending exact commit (`f9d6a03:src/team.js:2372`) | cơ chế tạo bản kết hợp và test có thể tách làm primitive; nền cũng có ở `ca01d50:src/team.js:2822` | thay pending approval từng job bằng integration attempt; review/test theo candidate, còn RC có approval riêng |
| checked-out target dùng ff-only; target khác dùng update-ref với old value (`f9d6a03:src/team.js:2398`, `f9d6a03:src/team.js:2399`) | CAS trên ref không checkout và kiểm tra sạch | không coi precheck rồi ff-only là CAS; dev/master phải dùng old SHA tại thao tác cập nhật cuối, xử lý checkout như mục 3 |
| restart đối chiếu ancestry và `q.state` (`f9d6a03:src/team.js:1921`) | đối soát Git trước chạy tiếp; test mô phỏng crash sau ref update | ancestry task revision chưa chứng minh đúng integration operation; cần expectedOld/exactNew/opId, không đánh dấu master đã promote chỉ vì ancestor |
| dashboard cookie cho queue, MCP không có action enqueue (`f9d6a03:src/server.js:158`, `f9d6a03:test/merge-queue.test.js:298`) | nguyên tắc quyền controller nằm ngoài body do agent gửi | không bê nguyên quyền chỉ dashboard cho auto-integration; scheduler gọi nội bộ sau policy, còn bật/tắt và duyệt nhạy cảm vẫn thuộc owner |
| cleanup screenshot thêm trong nhánh (`f9d6a03:src/preview.js:81`) | chỉ cân nhắc phần cleanup thiếu sau đối chiếu | không nhập cả preview cũ: snapshot có `removeTempDir` (`ca01d50:src/preview.js:12`) và master đã có checkpoint d1848fb6; RC preview cần pin riêng |

Các test queue là bằng chứng thiết kế test, **chưa được chạy trong task tài liệu này**: serial+sync+check lại revision (`f9d6a03:test/merge-queue.test.js:96`), conflict (`f9d6a03:test/merge-queue.test.js:121`), rejected review (`f9d6a03:test/merge-queue.test.js:145`), extra code (`f9d6a03:test/merge-queue.test.js:160`, `f9d6a03:test/merge-queue.test.js:178`), checkpoint sync lặp (`f9d6a03:test/merge-queue.test.js:221`), restart waiting (`f9d6a03:test/merge-queue.test.js:242`), crash sau ref update và không merge hai lần (`f9d6a03:test/merge-queue.test.js:258`). Fixture dùng nhánh `main`, repo/DB tạm và `t.after` đóng Team/xóa fixture (`f9d6a03:test/merge-queue.test.js:14`), nên đã có dấu hiệu không phụ thuộc tên master; chưa chứng minh dev + RC/CAS an toàn. **Test tái sử dụng queue là tiêu chí nghiệm thu của B, chưa có kết quả pass được bàn giao**; đọc diff không thay thế việc chạy baseline và test phần đã port trên exact revision B.

Lệnh xác minh phần tái dùng, giao controller chạy tại đúng revision nhánh hoặc revision B đã ghép, với fixture riêng; không checkout hay chạy nhánh khác từ task tài liệu này:

```text
# Tại revision f9d6a03: baseline hành vi queue, không phải nghiệm thu dev + RC
node --test --test-timeout=120000 test/merge-queue.test.js
# Tại revision B đã tích hợp với nền hiện hành: semaphore/retry và preview cleanup
node --test --test-timeout=120000 test/test-gate.test.js
node --test --test-timeout=120000 test/preview-cleanup.test.js test/preview-stop.test.js
# Tại revision B: hồi quy merge sẵn có, lọc thay vì chạy cả system suite
node --test --test-timeout=180000 --test-name-pattern="merge" test/system.test.js
```

Đọc trước fixture mỗi test để bảo đảm không dùng dataDir/credential thật; mọi lượt dưới 25 phút và giữ slot test duy nhất trên máy. Bộ queue test cũ cần đổi assertion “merged” sang “integrated_dev” và bổ sung tình huống ở mục 11; pass test cũ không thay thế test candidate/RC. Full suite do controller đặt lịch một lượt tại revision nghiệm thu, builder không chạy cả `test/system.test.js`.

## 2. Giữ 299a7e4d trong chuyển đổi

Giữ quyết định với job 299a7e4d: chưa hủy và chưa merge, không tự thay đổi trạng thái trong task này. Context ghi tip `9b9a1cc5`, là merge `da4a819` với `d05f189`; Git hiện không còn ref riêng và master trỏ tip đó, nên controller phải đối soát trước khi thực hiện tiếp, tránh merge lần hai. Dẫn chứng `da4a819` chỉ là lịch sử; nội dung hiện được kiểm theo commit `9b9a1cc5`. Nút recovery khi base đổi gọi control `sync`, khi thiếu check gọi `review` (`9b9a1cc5:public/app.js:1105`). Phần “đồng bộ master rồi bấm merge job” sẽ thừa sau khi queue dev tự dựng lại candidate. Trong giai đoạn còn đường thủ công cũ, nó vẫn có giá trị; đánh giá lại sau pilot B, không xóa trước khi có đường thay thế.

Phần hiển thị lỗi ngay trong popup **vẫn còn trong diff `d05f189...9b9a1cc5`**: sau response/refresh, job còn ready thì báo `ui.merge.notStarted` (`9b9a1cc5:public/app.js:1743–1746`), catch ghi `merge-error` (`9b9a1cc5:public/app.js:1748–1749`). Test nguồn tách lỗi API và trường hợp merge không bắt đầu (`9b9a1cc5:test/merge-resync-ui.test.js:78`, `9b9a1cc5:test/merge-resync-ui.test.js:88`); chưa chạy test trong task này. Sau pilot, giữ/tách phần báo lỗi nếu còn thiếu ở nền đích, chạy `node --test --test-timeout=30000 test/merge-resync-ui.test.js` trên revision triển khai, rồi điều chỉnh assertion cho operation API. Không áp lại patch nếu controller xác nhận nội dung đã tích hợp; không kéo cả UI sync cũ vào B/G và không triển khai lại phần lỗi đã dùng được.

## 3. Mô hình dev + RC và bất biến commit

### Dữ liệu và luồng tích hợp đề xuất

Giữ nhánh `ai-team/<id>` và worktree riêng; job mới lấy `refs/heads/dev` mới nhất, không lấy nhánh hiện đang checkout. Lưu riêng `originBase`, `taskRevision`, `integrationTarget=dev`; không dùng một `baseBranch` cho cả nguồn task lẫn đích nghiệm thu. MVP chỉ hỗ trợ một repo mỗi job; job linked-repo được giữ chờ đường owner vì cập nhật nhiều ref không có giao dịch Git chung. Code nền hiện có linked merge nối tiếp, có thể báo lỗi sau một repo đã merge (`ca01d50:src/team.js:2807`, `ca01d50:src/team.js:2851`); không quảng bá tính nguyên tử nhiều repo.

Mỗi repo có một worker tích hợp; agent vẫn code song song. Trạng thái đề xuất: `eligible → queued_dev → preparing → checking → integrated_dev`, hoặc `waiting_resource / needs_diagnosis / waiting_owner / conflict`. Tạo record integration riêng `{id, jobId, taskRevision, devBase, candidateCommit, tree, policyCommit, policyHash, checks, reviewIds, expectedOld, status, opId}`. Các bước:

1. Controller xác minh task HEAD sạch, đúng revision, test liên quan pass và không có finding chặn; lấy policy đáng tin và quyền theo mục 4. Chờ slot test không giữ agent/slot chạy code.
2. Giữ lease repo; đọc `D=refs/heads/dev`, tạo worktree candidate detached tại D và kết hợp taskRevision bằng merge do controller thực hiện. Không thao tác merge vào worktree builder. Conflict được lưu file/log, không cập nhật dev.
3. Ghim `I=candidateCommit`; chạy toàn bộ kiểm tra bắt buộc theo policy trên I, gồm kiểm tra tương tác với D và review phần kết hợp cần thiết. Nếu task vốn đã trên D, I có thể chính là taskRevision nhưng vẫn phải có chứng cứ gate cho tuple này. Sau test xác minh HEAD/tree không đổi và worktree sạch. Không cho test pass trên taskRevision được dùng thay cho test I.
4. Trước điểm cập nhật cuối, kiểm tra lại kill switch, policy epoch, duyệt nhạy cảm và taskRevision. Nếu policy đổi, hủy hiệu lực attempt và đánh giá lại. Lưu operation intent rồi chạy đúng `git update-ref refs/heads/dev <I> <D>` (CAS). Git từ chối nếu dev không còn là D.
5. CAS thành công mới ghi `integrated_dev`, task membership và dev health; không ghi task đã lên master. CAS thất bại do dev đổi thì giữ task/check cũ như lịch sử, dựng candidate mới từ D mới; không tăng vòng sửa code, không dùng lại kết quả I cho candidate khác.

Lease ngăn các controller worker cùng repo, CAS xử lý thay đổi ref ngoài worker. Không giữ transaction SQLite qua lệnh Git/test dài. Dev phải không checkout tại worktree người dùng; nếu đang checkout, trả lý do chờ rõ, không update-ref làm index lệch HEAD.

### Dev đỏ và giới hạn tồn đọng

Chỉ cập nhật `lastKnownGoodDev` sau check bắt buộc pass. Nếu phát hiện dev đỏ sau tích hợp, đóng admission thay đổi không liên quan, giữ preview tốt gần nhất cùng nhãn SHA/thời điểm; preview đó không được giả là HEAD hiện tại. Chẩn đoán bằng attempt/check logs; ưu tiên bản sửa có bằng chứng hoặc một revert commit do controller chuẩn bị, test trên dev hiện tại và CAS như task thường. Không reset/force-push dev để giấu lỗi. Nếu revert/sửa đụng nhóm nhạy cảm thì vẫn cần duyệt trước dev. RC bị ảnh hưởng phải chuyển `invalid`, không tiếp tục promote vì từng xanh.

Đề xuất mặc định cấu hình theo project: tối đa **5 job hoặc 20 commit** reachable từ dev nhưng chưa nằm trong master đã promote, chạm một ngưỡng là đóng admission; tính cả topic commit theo tập `master..dev`, không chỉ merge commit. Kiểm tra kích thước dự kiến trước CAS để không vượt ngưỡng bởi một job lớn. Pilot chỉ **1 job / 5 commit**. RC được duyệt nhưng chưa promote không làm giảm tồn đọng. Cảnh báo tồn đọng quá 24 giờ; chờ owner không tự hủy job. Bản sửa/revert để cứu dev có thể được owner cho ngoại lệ có audit, không do agent tự khai.

### RC, preview và promote master

Record RC bất biến đề xuất `{rcId, repo, commit=R, masterBase=M, taskIds+taskRevisions+integrationIds, tests, policyHash, risk, previewCommit, evidenceManifest, status}`. Tạo ref giữ commit RC để cleanup job không xóa mất bằng chứng. Danh sách task được tính từ integration ledger kể từ master đã promote, không lấy toàn bộ job ready. Chạy check RC theo policy; lưu lệnh, kết quả, môi trường, checksum log và exact SHA. Chưa đủ test/rủi ro chưa được xử lý thì RC không ở trạng thái nghiệm thu.

Preview RC chạy từ checkout sạch của **R**, không từ dev đang tiến và không từ worktree task có thể sửa. Chụp desktop/mobile của R, lưu revision trong manifest và response trạng thái của preview; sau restart chỉ dựng lại R. Preview hiện tại gắn revision job nhưng server after chạy ở `job.worktree` (`ca01d50:src/team.js:1684`, `ca01d50:src/team.js:1730`); phải tách thành preview RC. Có thể tái dùng route capture desktop/mobile (`ca01d50:src/team.js:1710`), readiness/kill-tree, nhưng controller RC phải tuân thủ cách ly mục 8. Preview hết TTL thì dựng lại cùng R; thiếu preview bắt buộc phải chờ, không tự coi đã nghiệm thu.

Owner duyệt tuple `{rcId, R, M, policyHash, evidenceManifestHash}`. Dev tiến tới R2 trong lúc owner test R không làm đổi R/preview/approval: master chỉ nhận R; phần R..R2 ở dev tiếp tục chờ RC sau. Sửa bất kỳ code nào của bản ứng viên thì tạo RC mới, check/preview/duyệt lại. Hotfix làm master khác M vô hiệu approval cũ; đưa hotfix vào dev qua bản kết hợp có kiểm tra rồi dựng/test RC mới, không tự rebase RC đã duyệt. Đồng bộ dev không conflict và kiểm tra/review lại pass không đòi owner duyệt job thường; nhóm nhạy cảm vẫn theo cổng trước dev ở mục 4. Quy tắc nội dung RC đổi phải duyệt lại không được áp nhầm thành duyệt lại từng job mỗi lần base tiến.

Promote phải vừa `--ff-only` vừa CAS, không gộp hai ý này thành “đọc master trước rồi merge”. Đề xuất thực hiện dưới lease repo:

```text
# Trong checkout detached tạm tại M, dùng Git để xác nhận ff-only tới đúng R
git merge --ff-only <R>
# Xác minh HEAD tạm == R, test/approval/manifest còn đúng, rồi trên repo quản lý ref:
git update-ref refs/heads/master <R> <M>
```

Không tạo merge commit mới khi promote. Nếu ff-only không thể thực hiện hoặc CAS thất bại thì không nâng master, approval cũ mất hiệu lực khi master đổi. Kiểm tra ancestry bằng `merge-base --is-ancestor M R` là preflight bổ sung, không thay old SHA của CAS. Nền hiện đã có ff-only và CAS cho hai loại target khác nhau (`ca01d50:src/team.js:2841`, `ca01d50:src/team.js:2848`, `ca01d50:src/team.js:2849`); cần kết hợp thành primitive promote chính xác.

Kiểm kê lịch sử từng thấy worktree chính checkout master; chưa xác minh lại bố trí runtime hiện tại. Trước bật promote mới, controller phải xác nhận ref master/dev được quản lý không checkout, và controller chạy từ release clone riêng ghim `runningCommit`; owner duyệt việc chuyển bố trí nếu còn cần. Không update-ref một master còn checkout rồi để index bẩn; nếu phát hiện checkout tại bất kỳ worktree nào, dừng promote với lý do cụ thể. Không tự đổi source checkout trong task/worker. Khi chưa có bố trí phù hợp, dùng đường thủ công cũ với tự động tắt.

Ba trạng thái riêng: `rcApproved` (owner chấp nhận nội dung R), `masterPromoted` (Git CAS tới R đã được đối soát), `runtimeApplied` (controller đã được owner cho cập nhật và thực sự chạy R). Duyệt RC không cấp quyền restart/deploy hoặc push remote. Dashboard cần `repoHead`, `runningCommit` đọc một lần lúc khởi động, `restartRequired`, SHA RC và thời điểm áp dụng. Nền hiện chỉ kiểm tra mtime file source để báo stale (`ca01d50:src/server.js:18`); thay đổi mtime không chứng minh phiên bản đang chạy.

## 4. Quyền, phân loại thay đổi và kích hoạt

`autoIntegrateEnabled=false` mặc định theo từng project; thêm kill switch toàn controller và riêng repo/project. Duyệt tài liệu/plan không bật cờ. Chỉ owner bật bằng thao tác riêng sau khi có evidence pilot và cấu hình policy đã được kiểm tra. Job thêm cơ chế không được đồng thời tự bật nó. Tắt khẩn cấp chặn bắt đầu attempt mới và được kiểm tra lại trước CAS; attempt đã hoàn tất CAS được đối soát và ghi nhận, không giả là chưa nhận. Push remote, cập nhật runtime và quyền nâng master vẫn cần owner.

Controller tính loại thay đổi từ diff Git thực tế (kể cả rename/delete và file mới), path chuẩn hóa, loại thao tác và policy đáng tin. Không dùng câu “risk low” do agent trả làm quyền thông qua. Code nền có regex sensitive và gate bằng diff (`ca01d50:src/team.js:164`, `ca01d50:src/team.js:2765`, `ca01d50:src/team.js:2004`), nhưng cần quy tắc rõ hơn cho controller/merge-test, tránh agent đổi pattern hoặc cấu hình test để tự qua.

| Nhóm đề xuất | Glob / loại thay đổi tối thiểu | Cổng trước dev |
| --- | --- | --- |
| UI/nội dung/sửa nhỏ | `docs/**`, `public/**`, `locales/*.json`, thay đổi ít module; loại trừ quyền/cấu hình cổng | test liên quan, không còn finding chặn; UI có ảnh desktop/mobile; tự tích hợp khi cờ đã bật |
| Logic nhiều module | diff chạm nhiều module/luồng API hoặc tương tác dữ liệu, vượt ngưỡng policy | test tích hợp bản kết hợp + reviewer độc lập xem tương tác; không cần owner nếu không thuộc nhóm nhạy cảm |
| Điều phối, merge/test | `src/team.js` (bảo thủ: toàn file cho đến khi có mapping vùng đáng tin), `src/process.js`, `src/providers.js`, module integration/policy/RC mới | owner duyệt trước dev, test đối kháng trên clone độc lập; không được tự bật tính năng |
| Auth/phân quyền | `src/server.js` (bảo thủ: toàn file), `src/accounts.js`, `src/capabilities.js`, `**/*auth*`, thay đổi route/quyền/session | owner duyệt trước dev + test quyền âm tính |
| Migration, xóa dữ liệu | `migrations/**`, `src/cleanup.js`, `src/transfer.js`, schema/SQL ở mọi đường dẫn, thay đổi delete/drop/truncate | owner duyệt trước dev, backup/restore trên DB thử, chứng minh không mất dữ liệu |
| Cấu hình test/cổng/build/quyền | `package*.json`, `.github/**`, `team.config*.json`, script test/CI, `test/**`, AGENTS/skill thay đổi quyền/cổng, policy manifests | owner duyệt trước dev khi thay đổi điều kiện kiểm; không cho giảm required checks; mặc định xét nhạy cảm khi chưa phân biệt được |

Tên đường dẫn là tập khởi đầu, không phải cho phép đổi tên để né. Khi không phân loại chắc, giữ `waiting_owner`; kết hợp glob với kiểm tra loại thay đổi, dependency và file rename. Mọi đề xuất sửa tests phải vẫn qua gate cũ; test mới bổ sung được chạy thêm. Với vi/ja/en chỉ thêm key và kiểm tra JSON/UTF-8; dashboard không dùng inline style trong HTML string.

Policy và danh sách required checks lấy từ **dev/master đã tin cậy hoặc cấu hình controller ngoài nhánh job**, ghim policyCommit/hash vào attempt. Nếu job sửa policy thì cổng cũ vẫn thực thi; policy mới chỉ có hiệu lực sau duyệt/tích hợp và kích hoạt riêng. Cả định nghĩa/assertion của check bắt buộc phải được ghim từ nguồn tin cậy và chạy với code candidate qua harness riêng; chỉ ghim tên lệnh rồi chạy file test đã bị job sửa là chưa đủ. Test bổ sung của job được chạy thêm, không thay thế check cũ. Scheduler và runner thuộc controller ổn định; agent chỉ có checkout task, không quyền gọi owner API/bật cờ/update-ref, không có controller credential. Quyền ref/DB/config thuộc tài khoản hoặc broker controller riêng; sandbox agent/test không được ghi Git common-dir hay gọi endpoint owner, vì chỉ cấm bằng prompt không phải cổng thực thi. Body API không được chứa quyền nội bộ kiểu queueAuth do client tự cấp; nhánh queue cũ đã phân biệt opts với quyền nội bộ (`f9d6a03:src/team.js:2323`), cần giữ nguyên nguyên tắc này.

## 5. Phân loại lỗi, bộ đếm, thời gian và chi phí

Nền hiện test/review/verify thất bại chuyển sang rework (`ca01d50:src/team.js:2251`, `ca01d50:src/team.js:2261`, `ca01d50:src/team.js:2279`); giới hạn tính `maxReworkRounds + scopeAdds + extraRounds` (`ca01d50:src/team.js:2283`). Quota/transient có blockedReason và tự resume (`ca01d50:src/team.js:2339`, `ca01d50:src/team.js:2388`). Giữ các checkpoint đó nhưng thay quyết định “thất bại → rework” bằng một classifier có bằng chứng trước khi đổi stage.

| Nhóm | Bằng chứng tối thiểu / hành động | Bộ đếm |
| --- | --- | --- |
| dev/master đổi | expectedOld khác ref thực tế hoặc CAS từ chối; lưu cặp SHA; dựng lại integration/RC theo mục 3 | không tính retry môi trường, chạy lại test hay sửa code; có metrics riêng |
| Chờ tài nguyên/phụ thuộc/quota | slot test/CPU/RAM/agent hoặc dependsOn chưa đủ; xếp hàng, lưu waitingSince/nextAction | không tính vòng; thời gian chờ riêng |
| Lỗi môi trường/runner đã biết | exit/spawn, công cụ thiếu, provider outage có mã và log; retry kỹ thuật hữu hạn sau khi điều kiện được khôi phục | `environmentRetriesUsed ≤ 2` |
| Timeout chưa rõ | lưu command, SHA, stdout/stderr trước timeout, PID cây con, tài nguyên, max/idle timeout, thời điểm output cuối; sang needs_diagnosis | không mặc định flaky, không tự sửa code; chẩn đoán rồi mới phân nhóm tiếp |
| Check thất bại cần chạy lại để xác minh | có tên check/kết quả đầy đủ, cùng candidate/môi trường, cho phép một lượt xác minh có lý do; giữ cả fail/pass | `testRerunsUsed ≤ 1`, không xóa lỗi cũ; timeout chưa rõ không đi đường này tự động |
| Lỗi code có bằng chứng | test tái hiện/assertion hoặc finding chặn gắn diff, input và expected/actual; giao sửa đúng phạm vi | `codeReworksUsed ≤ 3`; chạy test bản sửa là lượt đầu của candidate mới, không phải retry lồng |
| Conflict | danh sách file/hunk giữa task và dev; lưu attempt, giải conflict rồi test/review delta giải quyết + bản kết hợp | counter conflict riêng để quan sát; không mặc định là code rework |
| Cần owner | đổi phạm vi, chấp nhận rủi ro, nhóm nhạy cảm, hết ngân sách/chưa chẩn đoán được | waiting_owner, không tự nhận đáp án hoặc tự nới giới hạn |

Các số **2/1/3 là số lần chạy THÊM sau lần đầu**, cấu hình được. Một sổ attempt duy nhất ở controller cấp quyền chạy lại trước khi spawn, lưu bền theo job; runner/provider/test parser không được tự tạo vòng retry khác. Không reset counters chỉ vì đổi stage, restart hoặc base đổi. Ví dụ cùng check có 1 lượt đầu + tối đa 1 lượt xác minh; nếu runner hỏng trong lượt đó, tối đa 2 retry kỹ thuật dùng chung sổ, không biến thành `(1+2) × (1+1)` lần chạy. Phân loại lại cập nhật attempt cũ, không đếm hai lần cùng nguyên nhân. Candidate mới do code sửa có required tests mới, còn tổng retry/sửa/thời gian/token vẫn bị chặn theo job.

Hiện `runTests` chọn tên fail rồi retry một lần khi parser hợp lệ, pass thì ghi FLAKY_WARNING (`ca01d50:src/team.js:1933`, `ca01d50:src/team.js:1942`, `ca01d50:src/team.js:1947`). Tái dùng parser/bằng chứng test names và các kiểm tra kết quả đầy đủ; chuyển quyết định retry sang sổ chung. Một lần pass khi chạy lại không đủ kết luận nguyên nhân flaky; ghi “không tái hiện ở lần xác minh” nếu chưa có chẩn đoán. Không bỏ test, đổi assertion, đổi pattern né failure để xanh.

`testLimit()` mặc định 1 cùng acquire/release đã có (`ca01d50:src/team.js:1788`, `ca01d50:src/team.js:1929`, `ca01d50:src/team.js:1957`). Tái dùng, nhưng bổ sung slot test cấp máy nếu có nhiều controller/repo: biến trong một Team không tự bảo vệ máy khỏi runner khác. Candidate/RC/full suite phải dùng chung slot; builder không chạy full system suite. `src/process.js:114` trong taskContext là điểm cần xem lại: tại **ca01d50** dòng 114 là abort handler; max timeout mặc định 30 phút thực sự ở `ca01d50:src/process.js:117`–119, idle timeout ở `ca01d50:src/process.js:121`. Không lặp lại số dòng cũ như bằng chứng timeout. Mỗi lượt builder vẫn phải giới hạn dưới 25 phút bằng timeout phù hợp.

Giới hạn **6 giờ xử lý/job**, token theo `maxTokensPerJob` và chi phí/call budget cấu hình. ProcessingMs cộng các khoảng plan/code/test/review/chẩn đoán/chuẩn bị tích hợp đang thực thi; dùng hợp các khoảng chạy của job để không nhân đôi thời gian khi task con song song, đồng thời lưu agent-ms/token/cost riêng để thấy chi phí. Chờ tài nguyên/phụ thuộc/owner tạm dừng đồng hồ; restart chỉ đóng/đối soát khoảng đang mở, không tính toàn bộ thời gian controller tắt là xử lý. Chạm 6 giờ giữ checkpoint, chuyển cần owner xem, không tự hủy.

Ngưỡng chờ đề xuất: tài nguyên 30 phút, phụ thuộc 4 giờ, owner 24 giờ → cảnh báo/needsAttention, nhắc theo cooldown, không tính sửa code thất bại. Base đổi không đốt counter nhưng thời gian dựng/test thực sự vẫn vào processingMs, token/cost; ghi `baseRefreshCount`, `baseRefreshMs`, `baseRefreshCost`, chuỗi old/new SHA. Nếu 3 lần base đổi liên tiếp trong 30 phút mà chưa CAS được, cảnh báo thiếu tiến triển, giữ vị trí và đặt lượt tích hợp ưu tiên trong lease repo; không busy-loop và không tự tăng rework. Nếu tác nhân Git ngoài controller vẫn liên tục đổi ref, yêu cầu điều phối owner thay vì test vô hạn.

## 6. Review có điều kiện kết thúc

Finding chặn nghiệm thu chỉ gồm sai chức năng so với phạm vi đã chốt, mất dữ liệu, lỗi bảo mật hoặc regression có bằng chứng. Đề xuất cải thiện/style/tối ưu không bắt buộc đưa backlog liên kết job; không giữ job trong rework. Độ nghiêm trọng và tính chặn là hai trường riêng, không coi mọi medium/high do reviewer chọn là cùng một chính sách.

Đề xuất ledger `{findingId, fingerprint, category, blocking, criterionId, introducedByRevision, observedRevision, fileLine, reproducer, evidenceHash, state, ownerDecisionId}`. ID ổn định qua vòng; mỗi observation gắn exact diff base..revision và candidate đang xét. Phân loại: lỗi cũ chưa sửa, lỗi mới do patch sửa (dẫn patch/reproducer), lặp lại cùng finding (không tăng count hoặc mở vòng mới chỉ vì đổi lời). Finding mới chặn phải có chứng cứ vi phạm tiêu chí; ý tưởng ngoài phạm vi thành backlog hoặc câu hỏi owner, không kéo dài nghiệm thu bằng sở thích reviewer.

Owner quyết định giữ/loại/chấp nhận rủi ro có phạm vi, lý do và revision/evidence áp dụng; lưu record bền và đưa vào prompt mọi reviewer/verifier về sau. Chỉ mở lại khi code/bằng chứng mới làm điều kiện quyết định không còn đúng, phải chỉ ra sự thay đổi; không tự lật quyết định owner. Review kết thúc khi required checks trên đúng candidate pass, mọi finding chặn đã fixed/verified hoặc owner xử lý rủi ro trong quyền cho phép, không còn nghĩa vụ trong phạm vi chưa giải quyết. Không được dùng owner acceptance thay cho test bắt buộc.

Có thể tái dùng normalization findings/disputes và đường verifier phân xử (`ca01d50:src/team.js:2240`, `ca01d50:src/team.js:2258`, `ca01d50:src/team.js:2275`). Cần thêm ledger/dedup, phân biệt blocking/backlog và prompt truyền quyết định owner; hiện các đoạn trên tiêu thụ findings theo reports/revision và verdict, chưa phải ledger kết thúc như đề xuất.

## 7. Idempotency lệnh dashboard và phục hồi sau restart

Mỗi thao tác thay đổi trạng thái gửi `operationId` UUID cùng action, đối tượng, expectedVersion/expected SHA và payload hash. Unique key theo project/action/operationId trong SQLite. Response đề xuất gồm `{operationId, accepted, state, reason, targetCommit}`; accepted chỉ nghĩa đã ghi nhận intent, không đồng nghĩa Git đã xong. Cùng mã+cùng payload trả lại kết quả đang chạy/đã xong; cùng mã khác payload trả 409. Hai mã khác nhau cùng duyệt RC cũng phải hội tụ về một approval/promote nhờ unique transition theo rcId+R+M và CAS, không chỉ khóa nút UI.

Trước tác động Git ghi intent `{expectedOld,newCommit,action,lease,phase}`; sau CAS ghi success. Không dựa vào job JSON snapshot duy nhất: nền lưu toàn body bằng INSERT OR REPLACE (`ca01d50:src/team.js:702`, `ca01d50:src/team.js:722`), và có invalidate acceptance khi revision đổi (`ca01d50:src/team.js:712`). Queue/RC/operation ledger cần bảng hoặc mutation theo version/transaction ngắn để stale save không xóa approval/cancel đã nhận. Route control/merge hiện gọi trực tiếp rồi trả kết quả (`ca01d50:src/server.js:188`, `ca01d50:src/server.js:192`); cần envelop thao tác và query operation status, không suy đoán từ HTTP 200.

Startup giữ lock dataDir trước mở scheduler, đối soát intent với Git và cây tiến trình do chính instance quản lý:

- Ref đúng newCommit và manifest/operation hợp lệ: hoàn tất DB/event còn thiếu, không chạy merge/test lại vô cớ.
- Ref đúng expectedOld: chưa áp dụng; kiểm tra lại policy/quyền rồi resume hoặc chờ, không tự approve.
- Ref là hậu duệ newCommit: chỉ ghi operation từng được áp dụng khi ancestry kèm intent/ledger chứng minh được; không coi hậu duệ là đúng RC đã promote.
- Ref khác cả hai hoặc đường dẫn/tiến trình không xác định: needs_diagnosis, không reset ref hay kill PID chỉ vì số PID khớp.
- Đối soát child bằng instanceId, PID+thời điểm khởi động và command/cwd được phép; lock stale phải kiểm tra ownership trước giải phóng. Lease hết hạn không mặc nhiên cho phép chạy hai thao tác có thể còn sống.

Nhánh queue có recovery dựa ancestry và trạng thái (`f9d6a03:src/team.js:1921`), test crash sau update-ref (`f9d6a03:test/merge-queue.test.js:258`); dùng fixture/ý tưởng nhưng nâng bằng chứng thành operation exact SHA. Nền giữ lock PID với create-exclusive (`ca01d50:src/server.js:23`), constructor còn tự xử lý preview và job đang chạy (`ca01d50:src/team.js:322`, `ca01d50:src/team.js:327`); recovery mới phải biết chế độ bảo trì trước những tác động này.

## 8. Controller bảo trì và runtime ổn định

Controller ổn định là phiên bản duy nhất có quyền trên job/dataDir/repo thật. Controller thử nghiệm chạy **cổng 3335**, `maintenance:true`, dataDir tạm có lock riêng; không nhận job thật, không dùng credential thật, không push. Không dùng worktree của repo thật để thử cơ chế merge: worktree chia sẻ refs/config; dùng **clone repository độc lập**, không dùng shared object store/alternates, vô hiệu remote push và không kế thừa Git hooks/config/credential helper nhạy cảm. Home/provider profiles và token cho môi trường thử là dữ liệu thử riêng, không sao chép credential thật.

Snapshot SQLite bằng Online Backup API (`db.backup()` nếu adapter hỗ trợ) hoặc `VACUUM INTO`; không copy riêng file `.sqlite` đang WAL. Repo dùng `DatabaseSync` (`ca01d50:src/team.js:1`, `ca01d50:src/team.js:294`), đã có `VACUUM INTO` trong backup (`ca01d50:src/team.js:567`, `ca01d50:src/team.js:571`), nên chọn đường này khi chưa có API backup phù hợp; không gọi `db.backup()` như thể đã tồn tại. Chỉ controller được phép tạo snapshot thật qua API được owner cho phép; task thiết kế không mở DB. Snapshot mới chứa dữ liệu công việc nhạy cảm, dùng quyền thư mục phù hợp và thời hạn xóa.

Chặn tác động thật **ngay từ startup, trước khởi tạo các thành phần có side effect**, không chỉ bỏ `team.start()`. Nền constructor đã kill preview PID và đổi job khi restart (`ca01d50:src/team.js:322`), start gọi sweepGit/cleanup (`ca01d50:src/team.js:2403`), server tự refresh account/quota khi listen (`ca01d50:src/server.js:205`). Chỉ đặt port/DB khác sẽ vẫn nguy hiểm nếu bản sao chứa PID/đường dẫn thật.

Trình tự đề xuất:

1. Entry point xác thực maintenance mode, port, dataDir thử và allowlist root repo clone; lấy lock dataDir canonical; không khởi tạo Accounts/Team live hoặc auto-recovery trên snapshot thô.
2. Snapshot được mở bằng lớp chỉ migration/sanitize, không tạo scheduler/preview/agent. Vô hiệu mọi job nhập: trạng thái archived/imported, không tự requeue; bỏ PID/current/running, queue intent, pending approval và mọi quyền thao tác cũ. Giữ dữ liệu lịch sử cần chẩn đoán ở dạng inert.
3. Viết lại hoặc vô hiệu toàn bộ đường dẫn project/repo/worktree/linked/evidence/backup/attachment, cấu hình test/preview command, đích thông báo/webhook, account home và remote trong bản sao. Không chỉ sửa `projects[].path`. Trường chưa biết đường dẫn/command được chặn mặc định; từ chối symlink/junction thoát root cho phép.
4. Khởi tạo controller thử với runner/network/notifications mặc định từ chối tác động ngoài fixture. Muốn chạy test phải tạo **job tổng hợp mới** trên clone thử, không resume job đã sao lưu. Bật scheduler riêng chỉ cho fixture cho phép, sau khi xác minh sanitize xong.
5. Startup/restart maintenance đều kiểm tra boundary trước recovery. Tắt thì dừng/đợi cây tiến trình thuộc instance trong finally; không kill PID từ snapshot. Thử khởi động hai controller cùng dataDir phải bị lock từ chối trước side effect.

Nghiệm thu H do controller/verifier được cấp quyền thực hiện: lấy baseline Git refs/status, digest DB qua snapshot API và trạng thái job thật; khởi động thử, cố tình lỗi khi test/ref update, restart; xác minh Git/DB/job thật không đổi và không có thông báo/push/quota/account call thật. Chỉ đo/so sánh thông qua đường có quyền, không giao builder đọc dataDir thật. H phải có test từ lúc constructor, không chỉ test sau HTTP listen.

## 9. So sánh ngắn với hàng đợi thẳng vào master

| Tiêu chí cho repo này | Queue thẳng master | Dev + RC đã chọn |
| --- | --- | --- |
| Tái sử dụng code | gần luồng hiện tại `mergeCheck/merge` (`ca01d50:src/team.js:2757`, `ca01d50:src/team.js:2787`), ít record mới hơn | tái dùng primitive Git/test/evidence, thêm dev ledger, RC/approval, promotion và preview ghim |
| Owner nghiệm thu | nếu vẫn duyệt từng job sẽ giữ điểm nghẽn; nếu tự đẩy master thì thay đổi chưa nghiệm thu đi thẳng nhánh ổn định | owner xét nhóm task trên commit cố định; dev tiến tiếp không thay bản đang test |
| Controller tự sửa mình | ref master và mã source có thể tiến trước runtime; hiện chỉ báo stale theo mtime (`ca01d50:src/server.js:19`) | tách integrated/approved/promoted/applied, có release clone và maintenance; chi phí rollout ban đầu cao hơn |
| Xử lý base đổi | queue cũ sync task và kiểm lại, còn approval gắn job (`f9d6a03:src/team.js:1906`, `f9d6a03:src/team.js:2067`) | dựng lại candidate dev; chỉ hotfix master làm vô hiệu approval RC, không bắt owner xét lại mỗi job thường |
| Lỗi sau tích hợp | lỗi chạm ngay nhánh ổn định, cần revert master khẩn | đóng admission dev, giữ preview tốt, sửa/revert có test trước RC; cần giới hạn tồn đọng để không tích nợ |

Chi phí bổ sung chấp nhận: thêm schema/state machine, test kết hợp/RC, storage preview, CAS/recovery và quy trình bootstrap. Không cần mở lại quyết định kiến trúc; ưu tiên chứng minh một luồng nhỏ trước khi mở rộng UI/tự động cho nhiều project.

## 10. Kế hoạch chuyển đổi và các job nối tiếp

### Bootstrap, đổi đích job cũ và rollback vận hành

1. **A trước B:** A và tài liệu đã nằm trong nhánh cha `cf5f1d9`, không tạo lại hay coi nhánh task A là đầu ra tương lai. Controller nghiệm thu API trạng thái gọn có phân trang và job_detail trên revision bàn giao (`cf5f1d9:src/team.js:763–790`, `cf5f1d9:src/server.js:173–178`, `cf5f1d9:src/mcp.js:20–28`, `cf5f1d9:test/status-api.test.js`). Sau đó controller cung cấp inventory vận hành qua API đã nghiệm thu, bổ sung đối chiếu job/lock/tiến trình/phụ thuộc và chênh lệch master/299a7e4d ở mục 1 **trước migration**. Sự hiện diện mã và snapshot tài liệu không thay thế nghiệm thu A hay kiểm kê vận hành.
2. Owner duyệt plan và phạm vi bootstrap; **cờ auto vẫn tắt**. Controller ổn định V0 (phải ghi `runningCommit` thực tế, không suy ra từ master) tiếp tục điều phối job B trên worktree. B là sửa controller/merge-test, cần owner duyệt trước tích hợp. Trước khi có dev queue mới, các checkpoint cơ chế được test trong clone/DB tổng hợp riêng, owner duyệt exact commit; V0 dùng đường thủ công hiện hành để đưa bootstrap vào master. Đây là ngoại lệ chuyển đổi có chủ đích, không yêu cầu cơ chế chưa cài tự tích hợp chính nó. Nếu V0 không bảo đảm commit đúng/target không đổi thì dừng tự động, owner dùng quy trình Git có CAS và checkpoint đã kiểm; không bỏ gate.
3. Sau khi bootstrap đã test/duyệt và lên master, owner **cho phép cập nhật runtime riêng** để chạy V1. Không restart tự động từ approval nội dung. V1 tạo/ghi nhận dev tại master baseline đã kiểm, bố trí refs không checkout/release clone như mục 3, migrate record theo version và giữ legacy job intact. Mỗi bước migration có opId, backup và resume; lúc đang rollout không nhận tác vụ merge mới.
4. Job cũ chỉ đổi đích khi V1 có capability/policy/RC/recovery tối thiểu, controller đã đối soát không còn run/sync/merge đang thực hiện và có checkpoint sạch. Lưu `legacyBaseBranch`, base/revision cũ, reports/evidence/acceptance lịch sử; không đổi revision chỉ để sửa nhãn. Đặt integrationTarget=dev, dựng candidate với dev mới, chạy lại test bắt buộc và review phần kết hợp/conflict, phân loại nhạy cảm lại. Acceptance merge từng job cũ không được chuyển thành approval RC hay quyền tự bật tính năng. Ready cũ không tự trở thành eligible nếu thiếu chứng cứ.
5. Chạy pilot **một task ít rủi ro → test bản kết hợp → dev → tạo RC → preview đúng RC → owner duyệt → master nhận đúng RC** trên repo thử độc lập trước, rồi project thật chỉ khi owner cho bật riêng. Job pilot không chứa code bật auto; thao tác bật thuộc owner sau evidence. Dev có thể tiến trong lúc nghiệm thu RC, phải chứng minh master vẫn chỉ nhận R.
6. Nếu migration/pilot lỗi: kill switch, đóng admission/promote, dừng spawn mới, đối soát operation/ref đang dở trước bất kỳ thao tác nào khác. Giữ queue/RC/ledger/bằng chứng và branch checkpoint, không đổi status tất cả về failed hay reset dev. V1 tiếp tục chế độ manual/diagnostic nếu an toàn; nếu cần runtime V0, dùng snapshot schema tương thích và controller cũ chỉ đọc/điều phối legacy job đã được xác nhận, không cho V0 chạy queue mới không hiểu. Không restore DB cũ lên refs đã tiến mà chưa hòa đối soát. Đường dự phòng là owner vận hành thủ công exact candidate/test/approval/CAS, không merge lại task đã integrated/promoted.

### Chia việc nhỏ, có phụ thuộc thật

Định danh B/D/E/F/G/H là nhóm công việc nối tiếp, chưa tạo job mới trong task tài liệu. B dùng lại 52165d13; không merge nguyên nhánh cũ 687 dòng thêm. Các nhóm chạm `src/team.js` phải chia vùng hoặc tuần tự; “merge được riêng” nghĩa checkpoint mặc định tắt, schema tương thích và đủ test, không nghĩa các job không phụ thuộc nhau.

| Job / mốc | Phạm vi file đề xuất | Kết quả nhỏ có thể nghiệm thu riêng | Test riêng dự kiến (luôn có timeout) | dependsOn thật |
| --- | --- | --- | --- | --- |
| B1 — đổi mục tiêu 52165d13, schema/policy | vùng create/queue/save/gate trong `src/team.js`; module mới `src/integration.js`, `src/integration-policy.js`; guard cần thiết ở `src/server.js`; `test/integration-policy.test.js` | schema version, policy đáng tin, off mặc định, lease repo và record intent; chưa tự cập nhật ref | `node --test --test-timeout=120000 test/integration-policy.test.js`; baseline queue khi port fixture | A đã nghiệm thu + owner duyệt thiết kế; xử lý xung đột với nền hiện hành |
| B2 — candidate dev + CAS | `src/integration.js`, vùng runTests/queue của `src/team.js`, port `test/merge-queue.test.js`, mới `test/integration-queue.test.js` | tái dùng FIFO/checkpoint/recovery của 52165d13; test candidate rồi CAS; policy nhạy cảm chặn trước dev, không bật auto | `node --test --test-timeout=120000 test/integration-queue.test.js`; test gate và queue hồi quy lọc | B1; cần schema, policy, lease và intent trước CAS |
| B3 — RC/preview/promote tối thiểu | mới `src/release-candidate.js`, vùng preview trong `src/team.js`/`src/preview.js`, route tối thiểu `src/server.js`; `test/release-candidate.test.js`, `test/rc-preview.test.js` | RC bất biến, duyệt idempotent tối thiểu, preview đúng R, ff-only+CAS master, restart intent; API đủ để đi hết pilot, chưa mở rộng dashboard | `node --test --test-timeout=120000 test/release-candidate.test.js test/rc-preview.test.js` | B2; cần integration ledger để biết task membership và base |
| B4 — nghiệm thu xuyên suốt, không thêm cơ chế/bật cờ | test/evidence pilot trong clone/DB tổng hợp, nếu cần file mới `test/integration-flow.test.js`; cấu hình bật thật là thao tác owner ngoài diff | chứng minh toàn luồng mục 11 và ghi controller version; sau đó owner xét bật riêng 1 project/1 job | `node --test --test-timeout=180000 test/integration-flow.test.js`; controller đặt lịch full suite riêng | B3 + bootstrap/runtime V1 được owner cho phép; B4 hoàn tất mốc B |
| D — classifier, ngân sách/thời gian | vùng stage/rework/blocked/runTests trong `src/team.js`, metadata timeout `src/process.js`/`src/providers.js`, module mới `src/failure-policy.js`; test mới failure-policy, cập nhật test gate/rework/timeout | counters 2/1/3 dùng chung, không retry lồng, processing/wait tách, theo dõi base refresh | `node --test --test-timeout=120000 test/failure-policy.test.js test/rework-limit.test.js test/timeout.test.js`; test gate riêng | B4 (cần integration attempts/phase để phân loại chính xác) |
| E — kết thúc review | `src/team.js` vùng findings/prompt/review, `src/discussions.js`, `src/prompts.js` nếu đã có sau 2b699046; mới `test/review-ledger.test.js` | finding ledger, blocking/backlog, owner decision bền và prompt reviewer | `node --test --test-timeout=120000 test/review-ledger.test.js`; test prompt liên quan nếu tồn tại | D + B4; dùng classifier/count của D; nếu đụng prompt job 2b699046 phải hòa delta trước |
| F — idempotency/recovery mọi lệnh | `src/server.js`, `src/team.js`, mới `src/operations.js`; `test/operations.test.js`, `test/restart-reconcile.test.js` | mở rộng intent/idempotency tối thiểu đã có ở B cho dashboard controls; reconcile Git/child/lock/SQLite | `node --test --test-timeout=120000 test/operations.test.js test/restart-reconcile.test.js` | E + D + B4 để chuyển trạng thái/finding/time không bị replay sai |
| G — dashboard trạng thái/nghiệm thu | `public/{app.js,index.html,style.css}`, thêm key `locales/{vi,ja,en}.json`; phần projection ở `src/server.js` nếu cần; `test/rc-dashboard.test.js` | repoHead/runningCommit/restart, trạng thái chờ/diagnosis/RC/promoted chưa áp dụng, operation reason; giữ phần lỗi hữu ích 299a7e4d | `node --test --test-timeout=120000 test/rc-dashboard.test.js`; ảnh desktop/mobile đúng SHA RC | F + A + B3; lấy operation response/state projection ổn định, không đoán từ HTTP 200 |
| H — maintenance đầy đủ trên snapshot | entrypoint `src/server.js`, constructor/start của `src/team.js`, boundary `src/preview.js`/`src/providers.js`, mới `src/maintenance.js`; `test/maintenance-isolation.test.js` | sanitize snapshot trước side effect, clone độc lập, credential thử, khóa dataDir, test gây lỗi+restart | `node --test --test-timeout=180000 test/maintenance-isolation.test.js`; controller chạy nghiệm thu baseline thật qua quyền của mình | F + B4; triển khai sau B, có thể làm song song G chỉ khi đã tách vùng server/team và không dùng dữ liệu thật |

Thứ tự mặc định để giảm xung đột repo: **A → B1 → B2 → B3 → B4 → D → E → F → G → H**. H phụ thuộc F/B4, không phụ thuộc UI G về chức năng; chỉ song song khi phân vùng file rõ. Trước H, mọi test B–G dùng repo clone và DB tổng hợp mới, runner mock; tuyệt đối không khởi động candidate controller từ snapshot job thật. B cung cấp idempotency/recovery và policy tối thiểu để mốc xuyên suốt an toàn; F/H mở rộng, không hoãn các bất biến an toàn cơ bản tới cuối. Mọi job thay controller/merge/test cần owner duyệt trước dev; V1 ổn định điều phối chúng, test code mới ở môi trường thử, chỉ phiên bản đã promote và được owner cho cập nhật mới có quyền vận hành job thật.

## 11. Checklist nghiệm thu bằng test

Checklist là tiêu chuẩn cho các job triển khai; task tài liệu chỉ kiểm tra nội dung/UTF-8/dẫn chứng, không đánh dấu các tình huống chưa chạy là pass.

- [ ] B1: project mới, project migrate và restart đều `autoIntegrateEnabled=false`; duyệt plan không bật cờ; agent API/body không bật được; owner phải có thao tác kích hoạt riêng.
- [ ] B1/B2: controller bàn giao inventory vận hành qua A đã nghiệm thu trước migration; đối soát đủ bảy otherJobs, runtime/lock/dependency và chênh lệch ref 299a7e4d. B tái dùng 52165d13 theo diff, có log baseline/port queue trên exact revision B; chưa có kết quả pass ở task tài liệu.
- [ ] B1/B2: task sửa `src/team.js` vùng merge/test, process/provider, auth, migration/xóa dữ liệu hay policy/test config bị giữ `waiting_owner` trước dev; đổi tên file hoặc tự khai low risk không vượt gate; job sửa cổng vẫn chạy cổng từ dev/master đáng tin.
- [ ] B2: hai job pass riêng nhưng bản kết hợp fail thì dev không tiến, không đánh dấu integrated; test không bị bỏ/lọc để xanh; log chỉ đúng candidate SHA.
- [ ] B2: hai project trỏ cùng Git common-dir không tích hợp song song; repo khác vẫn chia đúng slot full suite cấp máy; task code song song vẫn được tiếp tục.
- [ ] B2: thay dev trong lúc candidate đang test hoặc ngay trước update-ref khiến CAS dev thất bại; task không bị tính code rework/retry, attempt mới dùng base mới và bắt buộc test lại.
- [ ] B2/B3: refs dev/master đang checkout ở worktree khác thì thao tác bị từ chối rõ; không làm lệch HEAD/index, không tự checkout/reset source của owner.
- [ ] B3/B4: task ít rủi ro đi hết candidate → dev → RC → preview → owner approval → master nhận **đúng R**; không có merge commit mới ngoài R khi promote.
- [ ] B3: dev tiến tới R2 trong khi owner test RC R; preview và evidence vẫn là R, master sau promote đúng R, task ở R..R2 vẫn chưa nghiệm thu.
- [ ] B3: code của ứng viên đổi tạo RC mới, kết quả test/preview/approval của R không dùng cho R2; preview sai SHA hoặc manifest thay đổi chặn duyệt/promote.
- [ ] B3/F: owner bấm duyệt hai lần cùng operationId trả cùng receipt; hai operationId khác nhau cùng RC vẫn chỉ một transition/promote và một kết quả có thể đối soát.
- [ ] B3/F: master hotfix trước hoặc sau nút duyệt nhưng trước CAS làm promote thất bại, approval cũ vô hiệu; tích hợp hotfix và test/preview/duyệt RC mới.
- [ ] B3/F: crash trước Git, sau CAS dev/master nhưng trước DB success, sau DB trước HTTP response; restart đối soát exact old/new/operation, không merge lại, không mất task membership/approval hợp lệ.
- [ ] B2/B3: dev đỏ sau tích hợp đóng admission không liên quan, giữ preview tốt gần nhất có nhãn SHA; repair/revert test trên dev hiện tại và qua policy, không reset lịch sử, không promote RC đã biết bị lỗi.
- [ ] B2/B3: admission vượt 5 job/20 commit (pilot 1/5) bị chặn trước CAS; duyệt RC mà chưa promote không giảm tồn đọng; chờ lâu chỉ cảnh báo, không tự hủy.
- [ ] D: environment thêm tối đa 2, xác minh test thêm tối đa 1, sửa code thêm tối đa 3; restart/chuyển stage không reset và retry lồng không nhân số lần spawn.
- [ ] D: timeout chưa rõ giữ log/PID/candidate/tài nguyên và chuyển diagnosis, không ghi flaky hoặc tự sửa code; fail rồi pass một lần vẫn giữ bằng chứng thất bại và lý do.
- [ ] D: job chờ owner/quota/tài nguyên/dependsOn qua nhiều giờ và qua restart không tăng processingMs/codeReworks; chỉ thời gian xử lý thực tế đạt 6 giờ mới chạm giới hạn; token/cost vẫn ghi đúng.
- [ ] D: 3 lần base đổi/30 phút không tiến triển tạo cảnh báo, giữ vị trí/điều phối lại; không test vô hạn hay đưa vào rework chỉ vì base đổi.
- [ ] E: reviewer nhắc lại cùng lỗi giữ finding ID; đề xuất cải thiện vào backlog; quyết định owner đã chốt được truyền prompt và chỉ mở lại khi có bằng chứng mới đúng điều kiện.
- [ ] F: stale save không làm sống lại queue đã hủy, mất owner decision hay ghi đè operation success; payload khác cùng mã bị 409, accepted=false trả lý do rõ.
- [ ] G: phân biệt Chờ tài nguyên / Đang chạy / Chờ job khác / Cần chẩn đoán / Chờ duyệt / Đã merge nhưng chưa áp dụng; hiển thị repoHead/runningCommit và RC SHA đúng; ảnh desktop/mobile của exact revision, không inline style HTML.
- [ ] H: snapshot qua backup API/VACUUM INTO; lock chặn hai instance; maintenance chặn ngay trước constructor recovery/scheduler/account/quota/notification; job từ bản sao không được tự chạy.
- [ ] H: snapshot chứa PID/đường dẫn repo/worktree/remote/webhook thật bị vô hiệu; khởi động, cố tình lỗi và restart controller maintenance tại 3335 không đổi Git/DB/job thật, không dùng credential thật hay push.
- [ ] Rollout: duyệt RC, nâng master, cập nhật runtime có ba record/quyền riêng; tắt auto giữa attempt và trước CAS có hành vi xác định; rollback giữ checkpoint/ledger và không cho V0 xử lý operation mới chưa hiểu.

Hoàn tất thiết kế khi đủ mục và dẫn chứng được kiểm; chỉ hoàn tất chuyển đổi khi các test trên có evidence tại revision triển khai, owner duyệt RC/promotion và cấp phép bật riêng. Không coi việc tạo tài liệu này là bật auto-integrate hay cho phép restart controller.
