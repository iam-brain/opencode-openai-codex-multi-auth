export class UnknownModelError extends Error {
	readonly availableModels?: string[];

	constructor(modelId: string, availableModels?: string[]) {
		const suffix =
			availableModels && availableModels.length > 0
				? ` Available models: ${availableModels.join(", ")}.`
				: "";
		super(
			`Unknown model "${modelId}". Update your config to a supported model ID.${suffix}`,
		);
		this.name = "UnknownModelError";
		this.availableModels = availableModels;
	}
}

export class ModelCatalogUnavailableError extends Error {
	constructor() {
		super(
			"Model catalog unavailable. Run once with network access to seed the /codex/models cache.",
		);
		this.name = "ModelCatalogUnavailableError";
	}
}

function isErrorLike(err: unknown): err is { name?: unknown } {
	return typeof err === "object" && err !== null;
}

export function isUnknownModelError(err: unknown): err is UnknownModelError {
	if (err instanceof UnknownModelError) return true;
	return isErrorLike(err) && err.name === "UnknownModelError";
}

export function isModelCatalogUnavailableError(
	err: unknown,
): err is ModelCatalogUnavailableError {
	if (err instanceof ModelCatalogUnavailableError) return true;
	return isErrorLike(err) && err.name === "ModelCatalogUnavailableError";
}

export function isModelCatalogError(
	err: unknown,
): err is UnknownModelError | ModelCatalogUnavailableError {
	return isUnknownModelError(err) || isModelCatalogUnavailableError(err);
}
