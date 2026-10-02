"""Chạy 1 LẦN DUY NHẤT để lấy OAuth refresh_token cố định dùng cho Drive.

Cách dùng:
  1. Trong Google Cloud Console > APIs & Services > Credentials, tạo 1 OAuth Client
     loại "Desktop app".
  2. Tải file client secret JSON, đặt cạnh script này với tên client_secret.json.
  3. Cài dependency (chỉ cần cho script này, không cần khi chạy service):
       pip install -r ../requirements-dev.txt
  4. Chạy: python get_refresh_token.py
  5. QUAN TRỌNG - đăng nhập bằng ĐÚNG tài khoản Google đang sở hữu/vận hành Apps Script
     hiện tại (tài khoản mà DriveApp trong .gs đang dùng để đọc folder ảnh/video/nhạc
     của các khách sạn hôm nay). Dùng lại đúng tài khoản này thì Cloud Run tự động kế
     thừa toàn bộ quyền đọc đã share sẵn - KHÔNG cần share lại từng folder khách sạn.
     Nếu dùng tài khoản khác, phải tự share lại từng folder khách sạn cho tài khoản đó.
  6. Copy 3 giá trị in ra vào .env / Secret Manager của Cloud Run
     (DRIVE_CLIENT_ID, DRIVE_CLIENT_SECRET, DRIVE_REFRESH_TOKEN).

refresh_token này không tự hết hạn (chỉ mất hiệu lực nếu bị thu hồi thủ công
hoặc không dùng liên tục >6 tháng) - đúng yêu cầu "token cố định không đổi".
Xác thực chỉ làm 1 LẦN cho mọi khách sạn - KHÔNG phải mỗi folder/khách sạn lại
xác thực lại; Cloud Run dùng chung 1 refresh_token này để đọc bất kỳ folder_id
nào mà tài khoản trên có quyền xem.

Nếu tổ chức có Google Workspace: nên gom toàn bộ folder video khách sạn vào 1
Shared Drive duy nhất, thêm tài khoản trên làm thành viên 1 lần - từ đó thêm bao
nhiêu khách sạn mới cũng không cần share lại (chỉ cần tạo folder con trong Shared
Drive đó). Code app/drive_client.py đã hỗ trợ đọc Shared Drive (supportsAllDrives).
"""

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def main() -> None:
    flow = InstalledAppFlow.from_client_secrets_file("client_secret.json", SCOPES)
    credentials = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    print("\nDán các dòng dưới vào .env / Secret Manager:\n")
    print(f"DRIVE_CLIENT_ID={credentials.client_id}")
    print(f"DRIVE_CLIENT_SECRET={credentials.client_secret}")
    print(f"DRIVE_REFRESH_TOKEN={credentials.refresh_token}")


if __name__ == "__main__":
    main()
