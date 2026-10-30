import pytest

import config


def test_required_returns_the_value(monkeypatch):
    monkeypatch.setenv("ZERORUNTIME_PROBE", "abc")
    assert config.required("ZERORUNTIME_PROBE", "a thing") == "abc"


def test_required_names_the_variable_and_the_fix(monkeypatch):
    monkeypatch.delenv("ZERORUNTIME_PROBE", raising=False)
    with pytest.raises(SystemExit) as exc:
        config.required("ZERORUNTIME_PROBE", "a thing")
    assert "set ZERORUNTIME_PROBE -- a thing" in str(exc.value)
    assert "voice/.env" in str(exc.value)
