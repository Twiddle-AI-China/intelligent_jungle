from __future__ import annotations

import sys
from typing import Callable, TypeVar

import pytest


LINUX_RELEASE_SECURITY_REQUIRES_LINUX = "LINUX_RELEASE_SECURITY_REQUIRES_LINUX"
_TestFunction = TypeVar("_TestFunction", bound=Callable[..., object])


def linux_release_security(test: _TestFunction) -> _TestFunction:
    marked = pytest.mark.linux_release_security(test)
    return pytest.mark.skipif(
        sys.platform != "linux",
        reason=LINUX_RELEASE_SECURITY_REQUIRES_LINUX,
    )(marked)
