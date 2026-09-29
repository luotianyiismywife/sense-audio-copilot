/**
 * Vision capability resolution for SenseAudio models.
 *
 * The platform's `/v1/models` endpoint does NOT return any capability flag —
 * verified 2026-09-29: the field set is exactly
 * `id / display_name / mode / protocols / desc / created / owned_by`.
 * In particular there is no `supports_vision`, so the previous implementation
 * (`supports_vision: m.supports_vision`) always produced `undefined` and the
 * vision-proxy picker was permanently empty.
 *
 * Resolution order (first hit wins):
 *   1. `/v1/models` `supports_vision` — used if the platform ever starts
 *      returning it (future-proof, no code change needed).
 *   2. models.dev — `attachment === true` or `modalities.input` contains
 *      "image". Cross-checked against OpenRouter's `architecture.input_modalities`
 *      on 2026-09-29; both sources agree on all 5 models they cover.
 *   3. Hardcoded fallback — for SenseAudio's own models, which are absent from
 *      both catalogs. Defaults to `false` (text-only) so an unknown model goes
 *      through the ask_image proxy instead of failing on a real image request.
 */
import { getApiModelMetadataList, type ApiModelMetadata } from "./apiModelList";
import { ensureModelsDevLoaded, lookupModelDevEntry, type ModelsDevEntry } from "./modelsDev";

/**
 * Hardcoded vision capability for models absent from models.dev / OpenRouter.
 *
 * SenseAudio's own models (senseaudio-s2*, sensenova-*) are not listed in either
 * catalog, and the official docs table has no vision column. Their `/v1/models`
 * `desc` makes no mention of image input, so they are treated as text-only.
 * Marking a text-only model as vision-capable would make real image requests
 * fail; the reverse only costs one extra ask_image round-trip.
 */
const HARDCODED_VISION: Record<string, boolean> = {
    "senseaudio-s2": false,
    "senseaudio-s2-flash": false,
    "senseaudio-s2-lite": false,
    "sensenova-6.8-flash-lite": false,
};

/**
 * Resolve whether a model accepts image input.
 *
 * @param modelId Model ID as returned by `/v1/models`.
 * @param apiMeta Cached `/v1/models` metadata for this model (may be undefined).
 * @param devEntry models.dev entry for this model (may be undefined).
 */
export function resolveVisionCapability(
    modelId: string,
    apiMeta: ApiModelMetadata | undefined,
    devEntry: ModelsDevEntry | undefined
): boolean {
    // 1. Platform flag (not currently returned, but honoured if it appears).
    if (apiMeta?.supports_vision !== undefined) {
        return apiMeta.supports_vision;
    }
    // 2. models.dev catalog.
    if (devEntry) {
        if (devEntry.attachment === true) {
            return true;
        }
        if (devEntry.modalities?.input?.includes("image")) {
            return true;
        }
        if (devEntry.attachment === false) {
            return false;
        }
    }
    // 3. Hardcoded fallback (SenseAudio's own models).
    return HARDCODED_VISION[modelId] ?? false;
}

/**
 * Get the set of model IDs that accept image input, for the vision-proxy picker.
 *
 * Combines the cached `/v1/models` list with models.dev metadata so the result
 * reflects the platform's current model set (not a hardcoded list).
 *
 * @param apiKey API key used to fetch `/v1/models`.
 * @returns Set of vision-capable model IDs (empty on total failure).
 */
export async function getVisionSupportedModelIds(apiKey: string | undefined): Promise<Set<string>> {
    const apiModels = await getApiModelMetadataList(apiKey);
    if (apiModels.length === 0) {
        return new Set();
    }
    // Warm the models.dev catalog (1h cache, silent degradation).
    await ensureModelsDevLoaded();

    const result = new Set<string>();
    for (const meta of apiModels) {
        const devEntry = lookupModelDevEntry(meta.id);
        if (resolveVisionCapability(meta.id, meta, devEntry)) {
            result.add(meta.id);
        }
    }
    return result;
}
