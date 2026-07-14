#pragma once

#include "WorldTypes.h"

namespace lcs {

class WorldEngine {
public:
    explicit WorldEngine(std::uint32_t seed = 0xC05A05u, std::size_t objectCount = 6);

    void advance(double elapsedSeconds);
    void setForce(UserForce force) noexcept;
    void release() noexcept;
    void noteOn(int midiNote, float velocity) noexcept;
    [[nodiscard]] const WorldState& state() const noexcept { return state_; }
    [[nodiscard]] std::vector<ControlFrame> controlFrames() const;

private:
    void fixedStep(float dt);
    void updateTelemetry();
    WorldState state_;
};

} // namespace lcs
