"""Аватарка в шапке: фото профиля Telegram через Bot API, с кешем; без фото — 404 и «TT»."""
import urllib.request
from urllib.error import HTTPError

import pytest

from tradetrust.bot import api
from tradetrust.bot.telegram import Telegram

from test_bot import FakeResponse, init_data, make_bot  # noqa: F401 — фикстура


class FakeTG:
    def __init__(self, photos):
        self.photos, self.calls = photos, []

    def post(self, url, json=None, timeout=None):
        method = url.rsplit("/", 1)[1]
        self.calls.append(method)
        result = {"getUserProfilePhotos": {"photos": self.photos},
                  "getFile": {"file_path": f"photos/{json.get('file_id')}.jpg"}}[method]
        return FakeResponse({"ok": True, "result": result})

    def get(self, url, timeout=None):
        assert "/file/bot123:ABC/photos/m.jpg" in url  # средний размер, не огромный оригинал
        r = FakeResponse(None)
        r.content = b"JPEG"
        return r


def test_profile_photo_picks_small_size_and_caches():
    fake = FakeTG([])
    fake.photos = [[{"file_id": "s", "width": 120}, {"file_id": "m", "width": 320}, {"file_id": "b", "width": 640}]]
    tg = Telegram("123:ABC", "42", session=fake)
    assert tg.profile_photo(42) == b"JPEG" and tg.profile_photo(42) == b"JPEG"
    assert fake.calls.count("getUserProfilePhotos") == 1
    assert Telegram("123:ABC", "42", session=FakeTG([])).profile_photo(7) is None


def test_photo_endpoint(make_bot):
    bot, _, _ = make_bot()
    tg = Telegram("123:ABC", "42", session=FakeTG([[{"file_id": "m", "width": 320}]]))
    server = api.serve(bot, "", 0, tg_token="123:ABC", owner_id="42", telegram=tg)
    base = f"http://127.0.0.1:{server.server_address[1]}/api/photo"
    try:
        req = urllib.request.Request(base, headers={"Authorization": "tma " + init_data(user_id=42)})
        resp = urllib.request.urlopen(req)
        assert resp.read() == b"JPEG" and resp.headers["Content-Type"] == "image/jpeg"
        with pytest.raises(HTTPError) as e:
            urllib.request.urlopen(base)
        assert e.value.code == 401
    finally:
        server.shutdown()
