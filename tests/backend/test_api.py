from political_map_studio.app import health
def test_health():
    assert health()["status"]=="ok"
