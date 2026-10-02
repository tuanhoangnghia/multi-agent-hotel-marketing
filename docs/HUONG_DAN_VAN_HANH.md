# Hướng dẫn vận hành — Hotel Marketing Automation (CHV Travel)

> Tài liệu dành cho người vận hành hàng ngày (không cần biết code). Chỉ cần thao tác trên Google Sheet và menu "🤖 AI Marketing". Muốn hiểu sâu về kỹ thuật/kiến trúc, xem [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Hệ thống này làm gì

Với mỗi dòng khách sạn trong Sheet, hệ thống tự động:
1. Chọn buyer persona phù hợp (nội bộ, không hiển thị cho khách).
2. Viết campaign brief (nội bộ).
3. Sinh nội dung đăng **Facebook** và **Zalo** theo đúng văn phong/template CHV.
4. (Nếu có video) Phân tích toàn bộ video thô của khách sạn qua AI (Gemini), tự viết mô tả + phụ đề (SRT) + kịch bản cắt/ghép video mới.
5. (Nếu có video) Gửi kịch bản đó sang dịch vụ ghép video để tạo video quảng cáo hoàn chỉnh.
6. Tạo draft bài Facebook kèm ảnh từ Drive (chưa đăng, chỉ tạo bản nháp).

## 2. Chuẩn bị dữ liệu trên Sheet

Mỗi dòng = 1 khách sạn. Các cột cần điền:

### Thông tin cơ bản
| Cột | Bắt buộc? | Ghi chú |
|---|---|---|
| `hotel_id` | Nên có | Mã định danh khách sạn |
| `ten_ks` | Nên có | Tên khách sạn |
| `gia` | Nên có | Giá — càng cụ thể càng tốt (VD: "4.010.000đ/phòng/đêm") |
| `destination` | Tuỳ chọn | Điểm đến/địa danh |
| `giai_doan` | Tuỳ chọn | Khoảng ngày áp dụng giá (VD: "02/09 - 15/10/2026") |
| `benefits_raw` | Tuỳ chọn | Quyền lợi/dịch vụ đi kèm, nên tách mỗi ý 1 dòng trong ô |
| `booking_note` | Tuỳ chọn | Ghi chú/điều kiện đặc biệt (phụ thu, mùa cao điểm...) |

**Lưu ý:** những cột tuỳ chọn nếu để trống, hệ thống sẽ **không tự bịa** — chỉ bỏ qua phần thông tin đó trong bài viết, không tạo ra số liệu/ngày tháng sai.

### Cho bài Facebook (ảnh)
| Cột | Ghi chú |
|---|---|
| `drive_folder_url` | Link thư mục Drive chứa ảnh khách sạn (để tự động chọn ảnh kèm bài Facebook) |

### Cho video (khuyến nghị dùng thay vì gõ tay mô tả)
| Cột | Ghi chú |
|---|---|
| `video_folder_url` | Link **thư mục** Drive chứa các video thô của khách sạn — AI sẽ tự xem và phân tích |
| `music_drive_url` | (Tuỳ chọn) Link 1 file nhạc nền cho video |

> [!WARNING]
> 2 cột `video_drive_url` và `video_subtitle_srt` (luồng cũ, gõ tay 1 video + phụ đề) **không còn dùng được nữa** — dịch vụ ghép video đã đổi cách nhận dữ liệu, chỉ còn nhận `video_folder_url`. Nếu dòng nào đang dùng 2 cột cũ này, cần chuyển sang điền `video_folder_url`.

## 3. Cách chạy

Mở menu **"🤖 AI Marketing"** trên thanh menu của Sheet:

- **"Chạy toàn bộ danh sách"** — xử lý tất cả các dòng chưa có `status = done`.
- **"Chạy dòng đang chọn"** — chỉ xử lý 1 dòng (click chọn 1 ô trong dòng đó trước khi bấm).

### Có video hay không sẽ chạy khác nhau

- **Dòng KHÔNG có `video_folder_url`:** chạy xong ngay trong 1 lần bấm — có kết quả Facebook/Zalo luôn.
- **Dòng CÓ `video_folder_url` nhưng chưa từng phân tích video:** hệ thống sẽ **gửi video đi phân tích rồi dừng lại** — chưa sinh Facebook/Zalo ngay trong lượt này (vì cần đợi AI xem xong video mới có đủ thông tin để viết bài). Việc phân tích mất vài phút. Sau khi phân tích xong, hệ thống **tự động chạy tiếp** toàn bộ phần còn lại (không cần bạn bấm lại gì cả) — kể cả khi bạn đã đóng Sheet/trình duyệt, quá trình vẫn chạy nền bình thường.

## 4. Theo dõi trạng thái

| Cột | Giá trị & ý nghĩa |
|---|---|
| `status` | `done` = xong hết. `error: ...` = có lỗi, đọc nội dung sau dấu `:` |
| `video_agent_status` | `skipped: no_video` (không dùng video) → `submitted` (đang phân tích, đợi) → `succeeded` (xong) / `error: ...` (lỗi) |
| `video_render_status` | `skipped: no_video` → `submitted` → `processing` (đang ghép) → `done` (xong, có link) / `error: ...` |
| `fb_post_status` | Trạng thái tạo draft bài Facebook kèm ảnh |

Nếu muốn kiểm tra ngay thay vì đợi tự động (chạy nền mỗi 1 phút), dùng 2 menu:
- **"Kiểm tra tiến độ phân tích video"**
- **"Kiểm tra tiến độ render video"**

### Kết quả để dùng
- `facebook_copy` — nội dung đăng Facebook (copy dán trực tiếp, hoặc dùng draft đã tạo sẵn nếu có ảnh)
- `zalo_copy` — nội dung đăng Zalo (đăng tay)
- `video_render_url` — link video hoàn chỉnh sau khi ghép xong

## 5. Chạy lại 1 dòng (VD: vừa sửa văn phong ở sheet Rules, muốn xem lại bài mới)

- Dùng **"Chạy dòng đang chọn"** → không cần xoá gì, luôn sinh lại `facebook_copy`/`zalo_copy` mới.
- Nếu dùng **"Chạy toàn bộ danh sách"** → cần xoá ô `status` của dòng đó (đang là `done`) để nó được xử lý lại.

**Quan trọng:** nếu chỉ muốn sinh lại bài Facebook/Zalo (không cần phân tích lại video), **đừng xoá** `video_agent_status`/`video_description`/`video_summary`/`video_srt`/`video_edit_script` — xoá các cột này sẽ khiến hệ thống phân tích lại video từ đầu (tốn thời gian + chi phí AI). Chỉ xoá các cột này khi bạn thực sự đổi video trong `video_folder_url` và muốn phân tích lại.

## 6. Tuỳ chỉnh văn phong nội dung — sheet "Rules"

Mở menu **"Mở sheet Rules & Skills"** để vào sheet cấu hình văn phong — sửa trực tiếp trên đây, **không cần biết code, không cần deploy lại**, sửa xong dùng ngay.

Mỗi dòng trong sheet Rules gồm 4 cột: `scope`, `target`, `rule_text`, `enabled`.

| scope | target | Dùng cho |
|---|---|---|
| `platform` | `facebook` | Văn phong + khung bài Facebook |
| `platform` | `zalo` | Văn phong + template bài Zalo |
| `persona` | *(để trống)* | Chỉ dẫn thêm khi chọn buyer persona |
| `brief` | *(để trống)* | Chỉ dẫn thêm khi viết campaign brief |
| `video_style` | *(để trống)* | Văn phong cho video (mô tả, phụ đề) |

- Sửa trực tiếp cột `rule_text` — lưu lại là lần chạy tiếp theo dùng ngay bản mới.
- Cột `enabled`: để `FALSE` để tạm tắt 1 rule mà không cần xoá dòng.
- Bài Zalo hiện đang theo **template cố định** (đúng khung khách hàng CHV dùng thật: 🔥 tên KS, 💰 giá, 📅 áp dụng, 🎁 quyền lợi, 📌 ghi chú, 📩 CTA cố định) — không nên sửa lệch cấu trúc trừ khi khách đổi format.
- Bài Facebook theo khung 9 phần linh hoạt hơn (hook cảm xúc → dẫn vào KS → mô tả → khối giá/tiện ích → ghi chú → đoạn cảm xúc đóng bài → CTA → sign-off → hashtag).

## 7. Thiết lập lần đầu / khi cần đổi token

Trong menu "🤖 AI Marketing":

| Menu | Dùng khi |
|---|---|
| "Thiết lập Facebook Page" | Lần đầu, hoặc khi Page Access Token hết hạn |
| "Kiểm tra kết nối Facebook" | Test xem token Facebook còn dùng được không |
| "Thiết lập Video Render API" | Lần đầu, hoặc khi bên vận hành dịch vụ ghép video đổi token |
| "Thiết lập Video Agent API" | Lần đầu, hoặc khi cần đổi token dịch vụ phân tích video |
| "Thiết lập Vertex AI (Claude)" | Lần đầu, hoặc khi đổi project GCP/service account |
| "Kiểm tra kết nối Vertex AI (Claude)" | Test xem Claude còn gọi được không |

## 8. Xử lý sự cố thường gặp

| Triệu chứng | Nguyên nhân khả năng cao | Cách xử lý |
|---|---|---|
| `status`/`video_render_status`/`video_agent_status` báo `error: ... 401 ...` hoặc "không hợp lệ" | Token (API key) sai hoặc đã bị đổi/hết hạn | Xin token hiện tại đúng từ người quản lý dịch vụ đó, thiết lập lại qua menu tương ứng (mục 7) |
| Bài Facebook/Zalo bị cắt cụt giữa chừng, thiếu hashtag/đoạn cuối | Giới hạn độ dài phản hồi AI quá ngắn so với nội dung cần viết | Đã khắc phục (2026-08) — nếu vẫn gặp lại, báo cho người phụ trách kỹ thuật |
| `video_agent_status`/`video_render_status` đứng yên ở `submitted` rất lâu (>15-20 phút) | Job có thể đang kẹt, hoặc trigger tự động chưa kịp chạy | Bấm menu "Kiểm tra tiến độ..." tương ứng để ép kiểm tra ngay; nếu vẫn không đổi, báo kỹ thuật kèm giá trị `video_agent_job_id`/`video_render_job_id` |
| Bấm chạy mà không thấy `facebook_copy`/`zalo_copy` xuất hiện | Dòng đó có `video_folder_url` và đang chờ phân tích video (xem mục 3) — đây là hành vi bình thường, không phải lỗi | Đợi vài phút hoặc bấm "Kiểm tra tiến độ phân tích video" |
| Đóng Sheet/trình duyệt giữa chừng | Không ảnh hưởng gì | Job vẫn tự chạy nền trên server của Google, không cần mở Sheet liên tục |

## 9. Lưu ý quan trọng

- Zalo/Facebook **không tự đăng bài** — chỉ sinh nội dung, người vận hành tự copy sang đăng (riêng Facebook có tạo thêm 1 bản **draft** kèm ảnh nếu có `drive_folder_url`, vẫn cần người vào Trình quản lý Trang bấm đăng tay).
- Nếu 1 khách sạn có `video_folder_url`, hệ thống **bắt buộc phải phân tích video xong mới viết bài** — vì input chắc chắn chỉ có tên khách sạn + giá, các thông tin khác có thể thiếu, phải dựa vào video để viết bài có nội dung thật.
- Muốn video mới đưa vào phân tích lại (đổi video trong thư mục), xem hướng dẫn ở mục 5.
