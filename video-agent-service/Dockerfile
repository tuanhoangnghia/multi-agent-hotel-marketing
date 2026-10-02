FROM python:3.12-slim

WORKDIR /app

# OpenCV (kéo theo bởi scenedetect, dùng để dò chuyển cảnh - xem app/scene_refiner.py) là bản
# build động, python:3.12-slim thiếu 3 thư viện này nên "import cv2" sẽ chết:
#   libGL.so.1 -> libgl1 | libgthread-2.0.so.0 -> libglib2.0-0 | libxcb.so.1 -> libxcb1
# Đã kiểm chứng bằng build thử: thiếu bất kỳ cái nào là ImportError lúc chạy, không phải lúc build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxcb1 \
 && apt-get clean

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PORT=8080
CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}
