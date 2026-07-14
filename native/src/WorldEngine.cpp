#include "lcs/WorldEngine.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <random>

namespace lcs {
namespace {
constexpr float tau = 6.2831853071795864769f;
float clamp01(float value) { return std::clamp(value, 0.0f, 1.0f); }
float wrap01(float value) { return value - std::floor(value); }
float phaseDelta(float target, float source) { return std::fmod(target - source + 1.5f, 1.0f) - 0.5f; }

float distance(const std::array<float, perceptualDimensions>& a, const std::array<float, perceptualDimensions>& b) {
    float sum{};
    for (std::size_t d = 0; d < a.size(); ++d) sum += (a[d] - b[d]) * (a[d] - b[d]);
    return std::sqrt(sum / static_cast<float>(a.size()));
}

float conflict(const SoundObjectState& a, const SoundObjectState& b) {
    const auto pitchA = a.pitchRegister * 12 + a.pitchClass;
    const auto pitchB = b.pitchRegister * 12 + b.pitchClass;
    const float registerOverlap = std::max(0.0f, 1.0f - std::abs(pitchA - pitchB) / 12.0f);
    const float spectralOverlap = std::max(0.0f, 1.0f - std::abs(a.perceptualPosition[0] - b.perceptualPosition[0]) * 2.2f);
    const float onsetOverlap = std::max(0.0f, 1.0f - std::abs(phaseDelta(a.rhythmPhase, b.rhythmPhase)) * 7.0f);
    const float panOverlap = std::max(0.0f, 1.0f - std::abs(a.pan - b.pan) * 1.5f);
    return registerOverlap * 0.34f + spectralOverlap * 0.30f + onsetOverlap * 0.20f + panOverlap * 0.16f;
}
} // namespace

WorldEngine::WorldEngine(std::uint32_t seed, std::size_t objectCount) {
    state_.seed = seed;
    state_.harmonicField = {1.0f, 0.0f, 0.18f, 0.12f, 0.0f, 0.15f, 0.0f, 0.35f, 0.0f, 0.12f, 0.08f, 0.0f};
    std::mt19937 random(seed);
    std::uniform_real_distribution<float> unit(0.0f, 1.0f);
    for (std::size_t index = 0; index < objectCount; ++index) {
        SoundObjectState object;
        object.id = static_cast<std::uint32_t>(index);
        object.role = index % 3 == 0 ? Role::bass : index % 3 == 1 ? Role::support : Role::ornament;
        object.identityAnchor = {
            0.18f + static_cast<float>(index) / std::max<std::size_t>(1, objectCount - 1) * 0.64f,
            0.18f + std::fmod(static_cast<float>(index) * 0.37f, 0.66f),
            object.role == Role::ornament ? 0.62f : 0.2f + unit(random) * 0.25f,
            object.role == Role::bass ? 0.72f : 0.38f + unit(random) * 0.3f,
            object.role == Role::support ? 0.24f : 0.48f + unit(random) * 0.3f,
            0.26f + unit(random) * 0.38f,
        };
        object.perceptualPosition = object.identityAnchor;
        for (auto& velocity : object.perceptualVelocity) velocity = (unit(random) - 0.5f) * 0.012f;
        object.naturalRate = 0.88f + unit(random) * 0.24f;
        object.rhythmPhase = wrap01(static_cast<float>(index) / static_cast<float>(objectCount) + unit(random) * 0.08f);
        object.energy = 0.34f + unit(random) * 0.28f;
        object.pitchClass = object.role == Role::bass ? (index % 2 ? 7 : 0) : object.role == Role::support ? (index % 2 ? 3 : 5) : (index % 2 ? 9 : 10);
        object.pitchRegister = object.role == Role::bass ? -1 : object.role == Role::ornament ? 1 : 0;
        object.pan = -0.78f + static_cast<float>(index) / std::max<std::size_t>(1, objectCount - 1) * 1.56f;
        state_.objects.push_back(object);
    }
    updateTelemetry();
}

void WorldEngine::advance(double elapsedSeconds) {
    state_.accumulator += std::clamp(elapsedSeconds, 0.0, 0.1);
    while (state_.accumulator + 1.0e-12 >= fixedTimeStep) {
        fixedStep(static_cast<float>(fixedTimeStep));
        state_.accumulator -= fixedTimeStep;
    }
    updateTelemetry();
}

void WorldEngine::setForce(UserForce force) noexcept { state_.force = force; }
void WorldEngine::release() noexcept { state_.force = {}; }

void WorldEngine::noteOn(int midiNote, float velocity) noexcept {
    state_.harmonicCenter = (midiNote % 12 + 12) % 12;
    state_.harmonicField[static_cast<std::size_t>(state_.harmonicCenter)] += clamp01(velocity) * 1.4f;
    state_.harmonicField[static_cast<std::size_t>((state_.harmonicCenter + 7) % 12)] += clamp01(velocity) * 0.62f;
    for (auto& object : state_.objects) object.energyVelocity += clamp01(velocity) * 0.12f;
}

void WorldEngine::fixedStep(float dt) {
    const float gather = state_.force.mode == ForceMode::gather ? state_.force.strength : 0.0f;
    const float disturbance = state_.force.mode == ForceMode::disturb ? state_.force.strength : 0.0f;
    const float targetTemperature = disturbance > 0 ? std::clamp(disturbance, 0.0f, 1.5f) : 0.0f;
    state_.temperature += (targetTemperature - state_.temperature) * dt / (disturbance > 0 ? 0.18f : 22.0f);
    for (auto& value : state_.harmonicField) value *= std::pow(gather > 0 ? 0.99996f : 0.99982f, dt * 200.0f);

    const auto previous = state_.objects;
    for (auto& object : state_.objects) {
        float phaseForce{};
        float totalWeight{};
        std::array<float, perceptualDimensions> averageVelocity{};
        for (const auto& other : previous) {
            if (other.id == object.id) continue;
            const float weight = std::exp(-distance(object.perceptualPosition, other.perceptualPosition) * 2.4f);
            phaseForce += weight * std::sin(tau * phaseDelta(other.rhythmPhase, object.rhythmPhase));
            for (std::size_t d = 0; d < perceptualDimensions; ++d) averageVelocity[d] += other.perceptualVelocity[d] * weight;
            totalWeight += weight;
        }
        const float previousPhase = object.rhythmPhase;
        const float rate = state_.tempo / 60.0f / 4.0f * object.naturalRate;
        const float coupling = 0.04f * (1.0f + gather * 1.4f) * phaseForce / std::max(totalWeight, 1.0e-6f);
        object.rhythmPhase = wrap01(object.rhythmPhase + rate * dt + std::clamp(coupling, -1.2f, 1.2f) * dt);
        object.pulse = object.rhythmPhase < previousPhase ? 1.0f : std::max(0.0f, object.pulse - dt * 3.5f);
        if (object.rhythmPhase < previousPhase) {
            const std::array<int, 3> offsets = object.role == Role::bass ? std::array<int, 3>{0, 7, 0}
                : object.role == Role::support ? std::array<int, 3>{3, 5, 7}
                : std::array<int, 3>{2, 9, 10};
            float bestScore = -1.0f;
            for (const int offset : offsets) {
                const int pitch = (state_.harmonicCenter + offset) % 12;
                if (state_.harmonicField[static_cast<std::size_t>(pitch)] > bestScore) {
                    bestScore = state_.harmonicField[static_cast<std::size_t>(pitch)];
                    object.pitchClass = pitch;
                }
            }
        }
        for (std::size_t d = 0; d < perceptualDimensions; ++d) {
            const float roleScale = d == 1 && object.role == Role::ornament ? -0.35f : 0.72f + static_cast<float>((object.id + d) % 3) * 0.12f;
            const float aligned = averageVelocity[d] / std::max(totalWeight, 1.0e-6f) * roleScale;
            const float user = state_.force.mode == ForceMode::guide ? (d == 0 ? state_.force.dx : d == 1 ? state_.force.dy : (state_.force.dx - state_.force.dy) * 0.18f) : 0.0f;
            const float temperatureNoise = std::sin((static_cast<float>(state_.time) * 37.0f + object.id * 17.0f + static_cast<float>(d) * 11.0f) * 1.618f) * state_.temperature * 0.018f;
            object.perceptualVelocity[d] += (aligned - object.perceptualVelocity[d]) * 0.54f * dt;
            object.perceptualVelocity[d] += user * dt * 0.42f;
            object.perceptualVelocity[d] += temperatureNoise * dt;
            object.perceptualVelocity[d] += (object.identityAnchor[d] - object.perceptualPosition[d]) * 0.028f * dt;
            object.perceptualVelocity[d] = std::clamp(object.perceptualVelocity[d] * std::pow(0.992f, dt * 200.0f), -0.16f, 0.16f);
            object.perceptualPosition[d] = std::clamp(object.perceptualPosition[d] + object.perceptualVelocity[d] * dt, 0.04f, 0.96f);
        }
        if (state_.force.mode == ForceMode::energize) object.energyVelocity += state_.force.strength * dt * 0.28f;
        object.energyVelocity += (0.48f - object.energy) * dt * 0.035f;
        object.energyVelocity *= std::pow(0.985f, dt * 200.0f);
        object.energy = std::clamp(object.energy + object.energyVelocity * dt, 0.12f, 0.94f);
        object.niche.holdSeconds = std::max(0.0f, object.niche.holdSeconds - dt);
        object.niche.cooldownSeconds = std::max(0.0f, object.niche.cooldownSeconds - dt);
    }

    const float threshold = 0.56f - (state_.force.mode == ForceMode::scatter ? state_.force.strength * 0.22f : 0.0f);
    for (std::size_t i = 0; i < state_.objects.size(); ++i) {
        for (std::size_t j = i + 1; j < state_.objects.size(); ++j) {
            auto& a = state_.objects[i]; auto& b = state_.objects[j];
            if (conflict(a, b) <= threshold || a.niche.cooldownSeconds > 0 || b.niche.cooldownSeconds > 0) continue;
            const bool moveA = a.niche.decisions < b.niche.decisions ||
                (a.niche.decisions == b.niche.decisions && std::sin(static_cast<float>(state_.seed) + static_cast<float>(state_.time) * 19.0f + a.id * 7.0f + b.id * 13.0f) > 0);
            auto& mover = moveA ? a : b;
            const float direction = std::sin(static_cast<float>(state_.seed) * 0.1f + mover.id * 2.3f + static_cast<float>(state_.time) * 5.1f) >= 0 ? 1.0f : -1.0f;
            const float registerCost = mover.role == Role::bass ? 0.8f : 0.38f;
            const float brightnessCost = std::abs(mover.perceptualPosition[0] - mover.identityAnchor[0]) + 0.22f;
            const float phaseCost = 0.34f;
            const float panCost = std::abs(mover.pan) * 0.35f + 0.18f;
            const float densityCost = std::abs(mover.perceptualPosition[5] - mover.identityAnchor[5]) + 0.28f;
            const float lowest = std::min({registerCost, brightnessCost, phaseCost, panCost, densityCost});
            if (lowest == registerCost) {
                mover.pitchRegister = std::clamp(mover.pitchRegister + (direction > 0 ? 1 : -1), -2, 2);
                mover.niche.action = "register";
            } else if (lowest == brightnessCost) {
                mover.perceptualPosition[0] = std::clamp(mover.perceptualPosition[0] + direction * 0.12f, 0.04f, 0.96f);
                mover.niche.action = "brightness";
            } else if (lowest == phaseCost) {
                mover.rhythmPhase = wrap01(mover.rhythmPhase + direction * 0.12f);
                mover.niche.action = "phase";
            } else if (lowest == panCost) {
                const float scatterAmount = state_.force.mode == ForceMode::scatter ? state_.force.strength : 0.0f;
                mover.pan = std::clamp(mover.pan + direction * (0.2f + scatterAmount * 0.18f), -0.95f, 0.95f);
                mover.niche.action = "pan";
            } else {
                mover.perceptualPosition[5] = std::clamp(mover.perceptualPosition[5] - 0.14f, 0.12f, 0.96f);
                mover.niche.action = "density";
            }
            mover.niche.holdSeconds = 0.53f;
            mover.niche.cooldownSeconds = 0.7f + mover.id * 0.07f;
            ++mover.niche.decisions;
        }
    }
    state_.time += dt;
}

void WorldEngine::updateTelemetry() {
    float real{}; float imaginary{};
    std::array<float, perceptualDimensions> center{};
    std::array<float, perceptualDimensions> meanVelocity{};
    for (const auto& object : state_.objects) {
        real += std::cos(object.rhythmPhase * tau); imaginary += std::sin(object.rhythmPhase * tau);
        for (std::size_t d = 0; d < perceptualDimensions; ++d) {
            center[d] += object.perceptualPosition[d];
            meanVelocity[d] += object.perceptualVelocity[d];
        }
    }
    const float count = static_cast<float>(std::max<std::size_t>(1, state_.objects.size()));
    for (auto& value : center) value /= count;
    for (auto& value : meanVelocity) value /= count;
    state_.telemetry.phaseCoherence = std::hypot(real / count, imaginary / count);
    float drift{}; float spread{}; float velocityDispersion{}; float masking{}; std::size_t pairs{}; float decisions{};
    for (std::size_t i = 0; i < state_.objects.size(); ++i) {
        drift += distance(state_.objects[i].perceptualPosition, state_.objects[i].identityAnchor);
        spread += distance(state_.objects[i].perceptualPosition, center);
        velocityDispersion += distance(state_.objects[i].perceptualVelocity, meanVelocity);
        decisions += static_cast<float>(state_.objects[i].niche.decisions);
        for (std::size_t j = i + 1; j < state_.objects.size(); ++j) { masking += conflict(state_.objects[i], state_.objects[j]); ++pairs; }
    }
    state_.telemetry.identityDrift = std::clamp(drift / count * 2.0f, 0.0f, 1.0f);
    state_.telemetry.identitySpread = std::clamp(spread / count * 2.0f, 0.0f, 1.0f);
    state_.telemetry.maskingCost = std::clamp(masking / std::max<std::size_t>(1, pairs), 0.0f, 1.0f);
    state_.telemetry.decisionRate = decisions / count / std::max(1.0, state_.time);
    state_.telemetry.trendAgreement = std::clamp(1.0f - velocityDispersion / count * 12.0f, 0.0f, 1.0f);
}

std::vector<ControlFrame> WorldEngine::controlFrames() const {
    std::vector<ControlFrame> frames;
    frames.reserve(state_.objects.size());
    for (const auto& object : state_.objects) frames.push_back({object.id, object.perceptualPosition, object.rhythmPhase, object.energy, object.pitchClass, object.pitchRegister, object.pan});
    return frames;
}

} // namespace lcs
