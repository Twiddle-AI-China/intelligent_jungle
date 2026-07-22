#include "lcs/WorldEngine.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>
#include <random>

namespace lcs {
namespace {
constexpr float tau = 6.2831853071795864769f;
float clamp01(float value) { return std::clamp(value, 0.0f, 1.0f); }
float wrap01(float value) { return value - std::floor(value); }
float phaseDelta(float target, float source) { return std::fmod(target - source + 1.5f, 1.0f) - 0.5f; }
float torusDelta(float target, float source) { return std::fmod(target - source + 1.5f, 1.0f) - 0.5f; }

std::array<float, 2> limitVector(float x, float y, float maximum) {
    const float magnitude = std::hypot(x, y);
    if (magnitude > maximum && magnitude > 0.0f) return {x / magnitude * maximum, y / magnitude * maximum};
    return {x, y};
}

float spatialAffinity(const SoundObjectState& a, const SoundObjectState& b, float radius = 0.42f) {
    const float distance = std::hypot(torusDelta(b.x, a.x), torusDelta(b.y, a.y));
    if (distance >= radius) return 0.0f;
    const float normalized = 1.0f - distance / radius;
    return normalized * normalized;
}

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
        for (auto& velocity : object.perceptualVelocity) velocity = 0.0f;
        object.naturalRate = 0.88f + unit(random) * 0.24f;
        object.rhythmPhase = wrap01(static_cast<float>(index) / static_cast<float>(objectCount) + unit(random) * 0.08f);
        object.energy = 0.34f + unit(random) * 0.28f;
        object.pitchClass = object.role == Role::bass ? (index % 2 ? 7 : 0) : object.role == Role::support ? (index % 2 ? 3 : 5) : (index % 2 ? 9 : 10);
        object.pitchRegister = object.role == Role::bass ? -1 : object.role == Role::ornament ? 1 : 0;
        object.pan = -0.78f + static_cast<float>(index) / std::max<std::size_t>(1, objectCount - 1) * 1.56f;
        object.panAnchor = object.pan;
        const float angle = tau * static_cast<float>(index) / static_cast<float>(objectCount) + (unit(random) - 0.5f) * 0.18f;
        const float heading = angle + tau * 0.25f + (unit(random) - 0.5f) * 0.7f;
        const float speed = 0.105f * (0.48f + unit(random) * 0.2f);
        object.x = wrap01(0.5f + std::cos(angle) * (0.18f + unit(random) * 0.08f));
        object.y = wrap01(0.5f + std::sin(angle) * (0.18f + unit(random) * 0.08f));
        object.vx = std::cos(heading) * speed;
        object.vy = std::sin(heading) * speed;
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
    const float scatter = state_.force.mode == ForceMode::scatter ? state_.force.strength : 0.0f;
    const float disturbance = state_.force.mode == ForceMode::disturb ? state_.force.strength : 0.0f;
    const float targetTemperature = disturbance > 0 ? std::clamp(disturbance, 0.0f, 1.5f) : 0.0f;
    state_.temperature += (targetTemperature - state_.temperature) * dt / (disturbance > 0 ? 0.18f : 22.0f);
    for (auto& value : state_.harmonicField) value *= std::pow(gather > 0 ? 0.99996f : 0.99982f, dt * 200.0f);

    const auto previous = state_.objects;
    struct SeparationForce { float brightness{}; float pan{}; float phaseRate{}; float maximumConflict{}; std::size_t partner{std::numeric_limits<std::size_t>::max()}; };
    std::vector<SeparationForce> separation(previous.size());
    const float conflictThreshold = 0.56f - scatter * 0.19f;
    for (std::size_t i = 0; i < previous.size(); ++i) {
        for (std::size_t j = i + 1; j < previous.size(); ++j) {
            const float amount = conflict(previous[i], previous[j]);
            if (amount <= conflictThreshold) continue;
            const float pressure = (amount - conflictThreshold) * (0.7f + scatter * 1.05f);
            const float brightnessDifference = previous[i].perceptualPosition[0] - previous[j].perceptualPosition[0];
            const float brightnessDirection = std::abs(brightnessDifference) > 1.0e-4f ? (brightnessDifference > 0 ? 1.0f : -1.0f) : (previous[i].id < previous[j].id ? -1.0f : 1.0f);
            const float panDifference = previous[i].pan - previous[j].pan;
            const float panDirection = std::abs(panDifference) > 1.0e-4f ? (panDifference > 0 ? 1.0f : -1.0f) : (previous[i].id < previous[j].id ? -1.0f : 1.0f);
            const float phaseDirection = phaseDelta(previous[i].rhythmPhase, previous[j].rhythmPhase) >= 0 ? 1.0f : -1.0f;
            separation[i].brightness += brightnessDirection * pressure * 0.16f;
            separation[j].brightness -= brightnessDirection * pressure * 0.16f;
            separation[i].pan += panDirection * pressure * 0.42f;
            separation[j].pan -= panDirection * pressure * 0.42f;
            separation[i].phaseRate += phaseDirection * pressure * 0.018f;
            separation[j].phaseRate -= phaseDirection * pressure * 0.018f;
            if (amount > separation[i].maximumConflict) { separation[i].maximumConflict = amount; separation[i].partner = j; }
            if (amount > separation[j].maximumConflict) { separation[j].maximumConflict = amount; separation[j].partner = i; }
        }
    }

    for (std::size_t index = 0; index < state_.objects.size(); ++index) {
        auto& object = state_.objects[index];
        const auto& before = previous[index];
        const float pointerX = torusDelta(before.x, state_.force.x);
        const float pointerY = torusDelta(before.y, state_.force.y);
        const float localInfluence = std::exp(-(pointerX * pointerX + pointerY * pointerY) / 0.08f);
        const float localGather = gather * localInfluence;
        float alignmentX{}; float alignmentY{}; float cohesionX{}; float cohesionY{};
        float spatialSeparationX{}; float spatialSeparationY{}; float spatialNeighbors{};
        for (const auto& other : previous) {
            if (other.id == before.id) continue;
            const float dx = torusDelta(other.x, before.x);
            const float dy = torusDelta(other.y, before.y);
            const float spatialDistance = std::hypot(dx, dy);
            if (spatialDistance >= 0.42f || spatialDistance < 1.0e-6f) continue;
            const float weight = 1.0f - spatialDistance / 0.42f;
            alignmentX += other.vx * weight; alignmentY += other.vy * weight;
            cohesionX += dx * weight; cohesionY += dy * weight;
            if (spatialDistance < 0.13f) {
                const float pressure = (1.0f - spatialDistance / 0.13f) / spatialDistance;
                spatialSeparationX -= dx * pressure; spatialSeparationY -= dy * pressure;
            }
            spatialNeighbors += weight;
        }
        float spatialForceX{}; float spatialForceY{};
        if (spatialNeighbors > 0.0f) {
            const auto alignment = limitVector(alignmentX / spatialNeighbors, alignmentY / spatialNeighbors, 0.105f);
            spatialForceX += (alignment[0] - before.vx) * 1.15f;
            spatialForceY += (alignment[1] - before.vy) * 1.15f;
            spatialForceX += cohesionX / spatialNeighbors * 0.34f + spatialSeparationX * 0.018f;
            spatialForceY += cohesionY / spatialNeighbors * 0.34f + spatialSeparationY * 0.018f;
        }
        if (state_.force.mode == ForceMode::gather) {
            spatialForceX += torusDelta(state_.force.x, before.x) * localInfluence * 0.72f;
            spatialForceY += torusDelta(state_.force.y, before.y) * localInfluence * 0.72f;
        } else if (state_.force.mode == ForceMode::scatter) {
            const float distanceFromPointer = std::max(0.035f, std::hypot(pointerX, pointerY));
            spatialForceX += pointerX / distanceFromPointer * localInfluence * 0.32f;
            spatialForceY += pointerY / distanceFromPointer * localInfluence * 0.32f;
        } else if (state_.force.mode == ForceMode::guide) {
            spatialForceX += state_.force.dx * localInfluence * 0.65f;
            spatialForceY += state_.force.dy * localInfluence * 0.65f;
        } else if (state_.force.mode == ForceMode::disturb) {
            const float turn = std::sin(static_cast<float>(state_.time) * 5.1f + before.id * 2.7f) * localInfluence * 0.34f;
            spatialForceX -= before.vy * turn; spatialForceY += before.vx * turn;
        }
        const auto limitedSpatialForce = limitVector(spatialForceX, spatialForceY, 0.24f);
        float nextVx = before.vx + limitedSpatialForce[0] * dt;
        float nextVy = before.vy + limitedSpatialForce[1] * dt;
        const float speedBudget = 0.105f * (state_.force.mode == ForceMode::energize ? 1.0f + localInfluence * 0.7f : 1.0f);
        const auto limitedVelocity = limitVector(nextVx, nextVy, speedBudget);
        nextVx = limitedVelocity[0]; nextVy = limitedVelocity[1];
        const float spatialSpeed = std::hypot(nextVx, nextVy);
        if (spatialSpeed < 0.105f * 0.34f) {
            const float heading = spatialSpeed > 1.0e-8f ? std::atan2(nextVy, nextVx) : before.id * 2.39996f;
            nextVx = std::cos(heading) * 0.105f * 0.34f;
            nextVy = std::sin(heading) * 0.105f * 0.34f;
        }
        object.vx = nextVx; object.vy = nextVy;
        object.x = wrap01(before.x + nextVx * dt); object.y = wrap01(before.y + nextVy * dt);
        float phaseForce{};
        float totalWeight{};
        std::array<float, perceptualDimensions> averageVelocity{};
        std::array<float, perceptualDimensions> averageOffset{};
        for (const auto& other : previous) {
            if (other.id == object.id) continue;
            const float weight = spatialAffinity(before, other);
            phaseForce += weight * std::sin(tau * phaseDelta(other.rhythmPhase, before.rhythmPhase));
            for (std::size_t d = 0; d < perceptualDimensions; ++d) {
                const float roleScale = d == 1 && before.role == Role::ornament ? -0.35f : 0.72f + static_cast<float>((before.id + d) % 3) * 0.12f;
                averageVelocity[d] += other.perceptualVelocity[d] * weight * roleScale;
                averageOffset[d] += (other.perceptualPosition[d] - other.identityAnchor[d]) * weight;
            }
            totalWeight += weight;
        }
        float neighborSpeedSquared{};
        for (const float value : averageVelocity) { const float mean = value / std::max(totalWeight, 1.0e-6f); neighborSpeedSquared += mean * mean; }
        const float neighborSpeed = std::sqrt(neighborSpeedSquared / static_cast<float>(perceptualDimensions));
        const float previousPhase = before.rhythmPhase;
        const float rate = state_.tempo / 60.0f / 4.0f * before.naturalRate;
        const float coupling = 0.04f * (1.0f + localGather * 1.4f) * phaseForce / std::max(totalWeight, 1.0e-6f);
        object.rhythmPhase = wrap01(before.rhythmPhase + (rate + separation[index].phaseRate) * dt + std::clamp(coupling, -1.2f, 1.2f) * dt);
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
            const float aligned = neighborSpeed > 0.0025f ? averageVelocity[d] / std::max(totalWeight, 1.0e-6f) : 0.0f;
            const float formationTarget = before.identityAnchor[d] + averageOffset[d] / std::max(totalWeight, 1.0e-6f);
            const float user = state_.force.mode == ForceMode::guide ? (d == 0 ? state_.force.dx : d == 1 ? state_.force.dy : (state_.force.dx - state_.force.dy) * 0.18f) * localInfluence : 0.0f;
            const float temperatureNoise = std::sin((static_cast<float>(state_.time) * 37.0f + before.id * 17.0f + static_cast<float>(d) * 11.0f) * 1.618f) * state_.temperature * 0.018f;
            object.perceptualVelocity[d] = before.perceptualVelocity[d];
            object.perceptualVelocity[d] += (aligned - before.perceptualVelocity[d]) * 0.54f * dt;
            object.perceptualVelocity[d] += (formationTarget - before.perceptualPosition[d]) * 0.09f * dt;
            object.perceptualVelocity[d] += user * dt * 0.42f;
            object.perceptualVelocity[d] += temperatureNoise * dt;
            object.perceptualVelocity[d] += (before.identityAnchor[d] - before.perceptualPosition[d]) * 0.028f * dt;
            if (d == 0) object.perceptualVelocity[d] += separation[index].brightness * dt;
            const bool activeMotion = neighborSpeed > 0.0025f || std::abs(user) > 1.0e-6f;
            object.perceptualVelocity[d] = std::clamp(object.perceptualVelocity[d] * std::pow(activeMotion ? 0.992f : 0.978f, dt * 200.0f), -0.16f, 0.16f);
            object.perceptualPosition[d] = std::clamp(before.perceptualPosition[d] + object.perceptualVelocity[d] * dt, 0.04f, 0.96f);
        }
        if (state_.force.mode == ForceMode::energize) object.energyVelocity += state_.force.strength * localInfluence * dt * 0.28f;
        object.energyVelocity += (0.48f - before.energy) * dt * 0.035f;
        object.energyVelocity *= std::pow(0.985f, dt * 200.0f);
        object.energy = std::clamp(before.energy + object.energyVelocity * dt, 0.12f, 0.94f);
        object.panVelocity = (before.panVelocity + separation[index].pan * dt + (before.panAnchor - before.pan) * 0.015f * dt) * std::pow(0.96f, dt * 200.0f);
        object.pan = std::clamp(before.pan + object.panVelocity * dt, -0.95f, 0.95f);
        object.niche.conflictSeconds = separation[index].maximumConflict > conflictThreshold ? before.niche.conflictSeconds + dt : std::max(0.0f, before.niche.conflictSeconds - dt * 0.5f);
        object.niche.holdSeconds = std::max(0.0f, before.niche.holdSeconds - dt);
        object.niche.cooldownSeconds = std::max(0.0f, before.niche.cooldownSeconds - dt);
    }

    const auto bar = static_cast<std::uint64_t>(std::floor((state_.time + dt) * state_.tempo / 240.0));
    if (bar > state_.lastBar) {
        const float barSeconds = 240.0f / state_.tempo;
        for (std::size_t i = 0; i < state_.objects.size(); ++i) {
            auto& object = state_.objects[i];
            if (separation[i].partner == std::numeric_limits<std::size_t>::max()) continue;
            auto& partner = state_.objects[separation[i].partner];
            if (object.niche.conflictSeconds < 60.0f / state_.tempo || object.niche.cooldownSeconds > 0 || object.niche.holdSeconds > 0) continue;
            const bool moveObject = object.niche.decisions < partner.niche.decisions || (object.niche.decisions == partner.niche.decisions && object.id < partner.id);
            if (!moveObject) continue;
            const int pitch = object.pitchRegister * 12 + object.pitchClass;
            const int partnerPitch = partner.pitchRegister * 12 + partner.pitchClass;
            const int direction = pitch == partnerPitch ? (object.role == Role::bass ? -1 : 1) : (pitch > partnerPitch ? 1 : -1);
            object.pitchRegister = std::clamp(object.pitchRegister + direction, -2, 2);
            object.niche.action = "register";
            object.niche.holdSeconds = barSeconds * (1 + ((object.id + state_.seed) & 1));
            object.niche.cooldownSeconds = barSeconds * 2.0f;
            object.niche.conflictSeconds = 0;
            ++object.niche.decisions;
        }
        state_.lastBar = bar;
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
    float meanVelocityNormSquared{};
    for (const float value : meanVelocity) meanVelocityNormSquared += value * value;
    const float meanVelocityNorm = std::sqrt(meanVelocityNormSquared);
    float drift{}; float spread{}; float speedSum{}; float agreement{}; float masking{}; std::size_t pairs{}; std::size_t active{}; float decisions{};
    for (std::size_t i = 0; i < state_.objects.size(); ++i) {
        drift += distance(state_.objects[i].perceptualPosition, state_.objects[i].identityAnchor);
        spread += distance(state_.objects[i].perceptualPosition, center);
        float speedSquared{}; float dot{};
        for (std::size_t d = 0; d < perceptualDimensions; ++d) {
            speedSquared += state_.objects[i].perceptualVelocity[d] * state_.objects[i].perceptualVelocity[d];
            dot += state_.objects[i].perceptualVelocity[d] * meanVelocity[d];
        }
        const float speed = std::sqrt(speedSquared / static_cast<float>(perceptualDimensions));
        speedSum += speed;
        if (speed > 0.0025f && meanVelocityNorm > 1.0e-6f) {
            agreement += std::clamp((dot / (std::sqrt(speedSquared) * meanVelocityNorm) + 1.0f) * 0.5f, 0.0f, 1.0f);
            ++active;
        }
        decisions += static_cast<float>(state_.objects[i].niche.decisions);
        for (std::size_t j = i + 1; j < state_.objects.size(); ++j) { masking += conflict(state_.objects[i], state_.objects[j]); ++pairs; }
    }
    state_.telemetry.identityDrift = std::clamp(drift / count * 2.0f, 0.0f, 1.0f);
    state_.telemetry.identitySpread = std::clamp(spread / count * 2.0f, 0.0f, 1.0f);
    state_.telemetry.maskingCost = std::clamp(masking / std::max<std::size_t>(1, pairs), 0.0f, 1.0f);
    state_.telemetry.decisionRate = decisions / count / std::max(1.0, state_.time);
    state_.telemetry.collectiveSpeed = std::clamp(speedSum / count * 10.0f, 0.0f, 1.0f);
    state_.telemetry.trendActive = active >= 2;
    state_.telemetry.trendAgreement = state_.telemetry.trendActive ? std::clamp(agreement / static_cast<float>(active), 0.0f, 1.0f) : 0.0f;
}

std::vector<ControlFrame> WorldEngine::controlFrames() const {
    std::vector<ControlFrame> frames;
    frames.reserve(state_.objects.size());
    for (const auto& object : state_.objects) frames.push_back({object.id, object.perceptualPosition, object.rhythmPhase, object.energy, object.pitchClass, object.pitchRegister, object.pan});
    return frames;
}

} // namespace lcs
