export function sessionPolicyForCondition(condition) {
  if (condition === "shared") return "shared";
  if (condition === "independent") return "per-vu";
  throw new Error("La condición debe ser shared o independent.");
}

export function validateSessionComparisonProfile(profile) {
  if (profile?.executor !== "per-vu-iterations" || profile.vus !== 2 || profile.iterationsPerVu !== 2 ||
      JSON.stringify(profile.typeByIteration) !== JSON.stringify([3, 1]) || !profile.cloud?.loadZone) {
    throw new Error("El perfil de comparación debe conservar 2 VUs, 2 iteraciones por VU, tipos [3, 1] y una zona cloud.");
  }
  return profile;
}
