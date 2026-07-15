"""Train the pitch-conditioned BRAVE variant with the official RAVE trainer.

The acids-rave CLI hardcodes ``rave.RAVE`` as the model class. Replacing that
symbol on the real ``rave`` module would also redirect gin's dynamic
registration, detaching the ``rave.RAVE:`` bindings in brave.gin from the
decorated base class. Instead, ``scripts.train`` gets a proxy module whose
``RAVE`` attribute is the conditioned subclass: gin bindings stay on
``rave.model.RAVE`` and reach the subclass through ``super().__init__``, while
only the instantiation site sees the swap. Pass the same flags as
``rave train``, including
``--config $BRAVE_REPO/configs/brave.gin --config configs/brave_pitch.gin``.
"""
from __future__ import annotations

from absl import app

import rave
import scripts.train as official_train

from latent_cosmos_research.pitch_rave import PitchConditionedRAVE


class _RaveModuleProxy:
    RAVE = PitchConditionedRAVE

    def __getattr__(self, name):
        return getattr(rave, name)


def main() -> None:
    official_train.rave = _RaveModuleProxy()
    app.run(official_train.main)


if __name__ == "__main__":
    main()
