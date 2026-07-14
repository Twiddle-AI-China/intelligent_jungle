#include "lcs/WorldEngine.h"

#include <cassert>
#include <cmath>
#include <iostream>

int main() {
    lcs::WorldEngine resting(18);
    for (int index = 0; index < 200; ++index) resting.advance(lcs::fixedTimeStep);
    assert(!resting.state().telemetry.trendActive);
    assert(resting.state().telemetry.trendAgreement == 0.0f);
    assert(resting.state().telemetry.collectiveSpeed == 0.0f);

    lcs::WorldEngine a(42), b(42);
    for (int index = 0; index < 400; ++index) a.advance(1.0 / 100.0);
    for (int index = 0; index < 200; ++index) b.advance(1.0 / 50.0);
    assert(a.state().objects.size() == 6);
    for (std::size_t index = 0; index < a.state().objects.size(); ++index) {
        const auto& left = a.state().objects[index];
        const auto& right = b.state().objects[index];
        assert(std::abs(left.rhythmPhase - right.rhythmPhase) < 1.0e-6f);
        assert(left.energy >= 0.12f);
        assert(left.pitchRegister >= -2 && left.pitchRegister <= 2);
        assert(left.pan >= -0.95f && left.pan <= 0.95f);
        assert(left.x >= 0.0f && left.x < 1.0f && left.y >= 0.0f && left.y < 1.0f);
        assert(std::hypot(left.vx, left.vy) > 0.01f);
        assert(std::abs(left.x - right.x) < 1.0e-6f);
        assert(std::abs(left.y - right.y) < 1.0e-6f);
        for (std::size_t d = 0; d < lcs::perceptualDimensions; ++d) {
            assert(std::isfinite(left.perceptualPosition[d]));
            assert(left.perceptualPosition[d] >= 0.04f && left.perceptualPosition[d] <= 0.96f);
            assert(std::abs(left.perceptualPosition[d] - right.perceptualPosition[d]) < 1.0e-6f);
        }
    }
    lcs::UserForce force;
    force.mode = lcs::ForceMode::scatter;
    force.strength = 1.0f;
    a.setForce(force);
    for (int index = 0; index < 2000; ++index) a.advance(lcs::fixedTimeStep);
    assert(a.state().telemetry.decisionRate < 2.0f);
    assert(a.controlFrames().size() == 6);
    for (const auto& object : a.state().objects) {
        assert(object.pitchRegister >= -2 && object.pitchRegister <= 2);
        assert(object.pan >= -0.95f && object.pan <= 0.95f);
        assert(object.rhythmPhase >= 0.0f && object.rhythmPhase < 1.0f);
    }
    std::cout << "lcs_core_tests passed\n";
}
