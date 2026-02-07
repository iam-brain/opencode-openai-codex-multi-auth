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
