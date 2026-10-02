import pytest

from app.gemini_client import _extract_json


def test_extract_json_from_plain_response():
    text = '{"a": 1, "b": [1, 2, 3]}'
    assert _extract_json(text) == {"a": 1, "b": [1, 2, 3]}


def test_extract_json_ignores_surrounding_text():
    text = 'Đây là kết quả:\n```json\n{"a": 1}\n```\nCảm ơn.'
    assert _extract_json(text) == {"a": 1}


def test_extract_json_raises_when_missing():
    with pytest.raises(ValueError):
        _extract_json("không có json ở đây")
