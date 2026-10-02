from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from .config import get_settings

_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
_VIDEO_MIME_PREFIX = "video/"


def _credentials() -> Credentials:
    settings = get_settings()
    if not (settings.drive_client_id and settings.drive_client_secret and settings.drive_refresh_token):
        raise RuntimeError(
            "Thiếu cấu hình OAuth Drive (DRIVE_CLIENT_ID/DRIVE_CLIENT_SECRET/DRIVE_REFRESH_TOKEN) - "
            "xem scripts/get_refresh_token.py để lấy refresh token 1 lần."
        )
    creds = Credentials(
        token=None,
        refresh_token=settings.drive_refresh_token,
        client_id=settings.drive_client_id,
        client_secret=settings.drive_client_secret,
        token_uri="https://oauth2.googleapis.com/token",
        scopes=_DRIVE_SCOPES,
    )
    creds.refresh(Request())
    return creds


def _drive_service():
    return build("drive", "v3", credentials=_credentials(), cache_discovery=False)


def list_videos_in_folder(folder_id: str, max_videos: int, max_duration_seconds: int) -> list[dict]:
    """Liệt kê tối đa max_videos file video trong thư mục, bỏ qua video dài hơn max_duration_seconds."""
    service = _drive_service()
    query = f"'{folder_id}' in parents and trashed = false"
    response = (
        service.files()
        .list(
            q=query,
            fields="files(id, name, mimeType, videoMediaMetadata)",
            pageSize=max(max_videos * 2, 20),
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        .execute()
    )
    videos: list[dict] = []
    for file in response.get("files", []):
        if not file.get("mimeType", "").startswith(_VIDEO_MIME_PREFIX):
            continue
        duration_ms = (file.get("videoMediaMetadata") or {}).get("durationMillis")
        if duration_ms is not None and int(duration_ms) > max_duration_seconds * 1000:
            continue
        videos.append(file)
        if len(videos) >= max_videos:
            break
    return videos


def download_video(file_id: str, destination_path: str) -> str:
    service = _drive_service()
    request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    with open(destination_path, "wb") as handle:
        downloader = MediaIoBaseDownload(handle, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
    return destination_path
