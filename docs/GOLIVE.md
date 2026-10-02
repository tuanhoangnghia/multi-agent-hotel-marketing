# Go-live Checklist: Dev → Khách hàng

> [!NOTE]
> Giả định đã chốt: hệ thống này triển khai theo mô hình **single-tenant** — toàn bộ
> Sheet/Drive/Facebook Page/Cloud Run chỉ phục vụ 1 khách hàng cụ thể. Nếu sau này cần
> phục vụ nhiều khách hàng khác nhau (multi-tenant), phần credential (mục 1) và hạ tầng
> (mục 2) cần thiết kế lại — không dùng checklist này trực tiếp.

Hiện tại (giai đoạn dev) mọi credential đều gắn với tài khoản/project cá nhân của dev
(`devbof@edu.gimasys.com`, project `gcp-learning-bachvx`). File này liệt kê những gì cần
đổi/làm thêm trước khi giao cho khách hàng dùng thật.

---

## 1. Credential phải đổi (đang là của dev, không dùng được cho khách hàng)

| Credential | Hiện tại (dev) | Khi go-live | Ai làm |
|---|---|---|---|
| Drive OAuth refresh token (`DRIVE_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`) | `devbof@edu.gimasys.com` | Chạy lại `video-agent-service/scripts/get_refresh_token.py` bằng tài khoản thật sẽ vận hành Apps Script cho khách hàng (hoặc tài khoản của chính khách hàng) | Dev chạy, cần tài khoản đúng của khách hàng/người vận hành |
| `FB_PAGE_ID` / `FB_PAGE_ACCESS_TOKEN` | chưa cấu hình / page test | Facebook Page thật của khách hàng | **Khách hàng** cấp quyền admin Page, hoặc tự tạo token |
| `GEMINI_API_KEY` | key test/free tier | Key production, gắn billing chính thức | Dev tạo trên project prod |
| `CLAUDE_API_KEY` | key dev | Key production đủ hạn mức cho traffic thật | Dev tạo trên project prod |
| `API_BEARER_TOKEN` / `INTERNAL_TASK_TOKEN` (Video Agent) | tự sinh lúc test ở `gcp-learning-bachvx` | Sinh mới cho prod, không tái dùng token dev | Dev (script trong README video-agent-service) |
| `VIDEO_RENDER_API_TOKEN` (Cloud Run render hiện có) | token test (nếu có) | Xác nhận với bên vận hành service đó có cần token riêng cho khách hàng này không | Dev + bên vận hành Cloud Run render |

---

## 2. Hạ tầng cần tách riêng, không dùng chung với dev

- [ ] Tạo **GCP project mới, riêng cho khách hàng này** — không tiếp tục dùng
      `gcp-learning-bachvx` (đang lẫn với `gimasys-internal-portal`/`gimasys-portal`
      không liên quan).
- [ ] Deploy lại toàn bộ checklist trong
      [`video-agent-service/README.md`](video-agent-service/README.md) (bật API, Firestore,
      Cloud Tasks queue, service account riêng, secret, `gcloud run deploy`) vào project mới.
- [ ] Đẩy code `.gs` vào Apps Script project **gắn với Google Sheet thật của khách hàng**
      (copy thủ công qua Apps Script editor, hoặc setup `clasp push` nếu dùng CLI) — không
      phải sheet test hiện tại.
- [ ] Giữ `gcp-learning-bachvx` làm môi trường dev/test lâu dài, không để lẫn job/dữ liệu
      thật của khách hàng vào đó.

---

## 3. Việc chỉ khách hàng (hoặc người được họ uỷ quyền) mới làm được

- [ ] Share folder Drive chứa video/ảnh thật cho đúng tài khoản đứng sau refresh token mới
      (mục 1) — xem hướng dẫn chi tiết trong
      [`video-agent-service/README.md`](video-agent-service/README.md#lấy-drive-oauth-refresh-token-làm-1-lần).
- [ ] Cấp quyền admin Facebook Page để tạo `FB_PAGE_ACCESS_TOKEN`.
- [ ] Xác nhận đồng ý (bằng văn bản/email) cho hệ thống truy cập Drive + đăng draft lên
      Facebook Page của họ — vì hệ thống sẽ đọc/ghi dữ liệu thật của khách hàng.

---

## 4. Checklist thực hiện theo thứ tự

1. [ ] Chốt GCP project prod với khách hàng (project mới hay project có sẵn của họ).
2. [ ] Xin quyền truy cập Drive video từ khách hàng (folder nào, share cho tài khoản nào).
3. [ ] Chạy `scripts/get_refresh_token.py` bằng tài khoản đã được share ở bước 2.
4. [ ] Tạo Gemini API key + Claude API key production.
5. [ ] Deploy `video-agent-service` lên project prod theo README (mục "Deploy lên Cloud Run").
6. [ ] Xin `FB_PAGE_ID`/tạo `FB_PAGE_ACCESS_TOKEN` từ khách hàng, test bằng
       "Kiểm tra kết nối Facebook" trong menu Apps Script.
7. [ ] Đẩy `.gs` vào Apps Script project gắn với Sheet thật của khách hàng, điền Script
       Properties (Claude key, Facebook, Video Render token, Video Agent token/URL).
8. [ ] Chạy thử "Chạy dòng đang chọn" trên 1 dòng test với dữ liệu thật (video ngắn) trước
       khi chạy toàn bộ danh sách thật.
9. [ ] Set billing alert trên project prod (Gemini + Cloud Run cost tăng theo traffic thật).

---

## 5. Sau go-live

- Theo dõi log Cloud Run (`gcloud run services logs read video-agent-service`) và
  `video_agent_status`/`video_render_status` trên Sheet trong tuần đầu để bắt lỗi sớm.
- Không dùng lại project/credential prod này để tiếp tục dev tính năng mới — quay về
  `gcp-learning-bachvx` cho việc phát triển tiếp theo, chỉ deploy lên prod khi đã test xong.
