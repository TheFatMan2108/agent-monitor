# Agent Monitor

Mod cho Claude Code: một pane nằm cạnh khung chat, cho bạn thấy cùng lúc **Claude Code** và **Codex CLI** đang làm gì, giao việc cho nhau ra sao, và **mỗi bên còn bao nhiêu limit**.

![Hình minh họa pane Agent Monitor](docs/preview.svg)

*Hình minh họa với dữ liệu mẫu, không phải ảnh chụp màn hình.*

## Tính năng

**Limit riêng cho từng agent**
- Claude Code: limit 5 giờ, limit tuần, thời gian đến lúc reset, và context còn lại của phiên.
- Codex CLI: limit 5 giờ, limit tuần, gói đang dùng, và thời điểm số liệu được cập nhật.
- Tất cả tính theo phần trăm **còn lại**. Dòng đổi màu khi còn dưới 20% và dưới 5%.

**Tiến trình**
- Agent chính và các subagent của Claude, hiển thị lồng theo quan hệ cha con: trạng thái, công cụ đang chạy, số lần gọi, thời gian, token đã dùng. Nút **Xem** mở transcript của subagent.
- Các lần chạy Codex CLI: đang chạy hay đã xong, thư mục làm việc, công cụ gần nhất, số lần gọi, token.
- Các phiên Claude khác đang mở trên cùng máy.

**Tương tác**
- Dòng thời gian mới nhất lên trước: Claude giao việc cho Codex, Codex trả kết quả (xong, lỗi, hết giờ chờ MCP), subagent được tạo, agent nhắn tin cho nhau, agent kết thúc.

## Cài đặt

Tại prompt của một phiên terminal:

```
/plugin install agent-monitor --marketplace TheFatMan2108/agent-monitor
```

Từ shell:

```bash
claude plugin install agent-monitor --marketplace TheFatMan2108/agent-monitor
```

Trong ứng dụng desktop, nơi `/plugin` không chạy: bấm **+** cạnh ô nhập, chọn **Plugins**, **Add marketplace** với `TheFatMan2108/agent-monitor`, rồi **Add plugin**.

## Sử dụng

Pane tự mở khi phiên bắt đầu. Nếu đã đóng, gõ `/agent-monitor` để mở lại.

## Nguồn dữ liệu và quyền riêng tư

Mod chỉ quan sát, không chặn hay sửa bất kỳ lệnh gọi nào. Mod không gọi model, nên không tốn limit, và không kết nối mạng.

| Dữ liệu | Lấy từ |
| --- | --- |
| Limit và context của Claude | API của Claude Code (`$.session.usage`) |
| Subagent, công cụ, tin nhắn | Sự kiện trong phiên Claude hiện tại |
| Limit và tiến trình Codex | `~/.codex/sessions/**/rollout-*.jsonl` (hoặc `CODEX_HOME`) |
| Phiên Claude khác | `~/.claude/sessions/*.json` |

- Không đọc `auth.json`, `config.toml` hay các file `*.key`.
- Từ log Codex chỉ lấy tên công cụ, trạng thái, số token, số liệu limit và tên thư mục. Không lưu nội dung hội thoại, tham số hay kết quả công cụ.
- Feed lưu tối đa 120 ký tự đầu của tin nhắn hoặc task, và chỉ trong bộ nhớ của phiên.

## Hạn chế

- Limit Codex chỉ cập nhật khi Codex thực sự gọi API. Sau giờ reset, pane báo đã reset thay vì giữ con số cũ.
- Định dạng log của Codex không phải API công khai, nên có thể thay đổi theo phiên bản. Khi không đọc được, phần Codex sẽ ẩn hoặc báo chưa có dữ liệu, không ảnh hưởng phiên làm việc.
- Limit của Claude chỉ có với gói subscription và sau lượt gọi API đầu tiên.
- Dòng Claude giao việc cho Codex chỉ ghi nhận khi gọi qua MCP `codex-cli`. Lần chạy `codex exec` trực tiếp vẫn hiện ở mục tiến trình.

## Phát triển

```bash
claude plugin validate .
claude plugin test .
```
