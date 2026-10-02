import hmac
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import get_settings

_bearer_scheme = HTTPBearer(auto_error=False)


async def verify_bearer_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer_scheme)] = None,
) -> None:
    settings = get_settings()
    if not settings.api_bearer_token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Service chưa cấu hình API_BEARER_TOKEN",
        )
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Thiếu bearer token")
    token = credentials.credentials
    if not hmac.compare_digest(token, settings.api_bearer_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token không hợp lệ")


async def verify_internal_task_token(x_internal_task_token: str = Header(default="")) -> None:
    settings = get_settings()
    if not settings.internal_task_token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Service chưa cấu hình INTERNAL_TASK_TOKEN",
        )
    if not hmac.compare_digest(x_internal_task_token, settings.internal_task_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Internal task token không hợp lệ")
