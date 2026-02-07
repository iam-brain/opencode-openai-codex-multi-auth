import { describe, it, expect, vi } from 'vitest';
import {
	normalizeModel,
	getModelConfig,
	filterInput,
	transformRequestBody,
} from '../lib/request/request-transformer.js';
import type { RequestBody, UserConfig, InputItem } from '../lib/types.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Request Transformer Module', () => {
	describe('normalizeModel', () => {
		it('should normalize known gpt-5.x codex models', async () => {
			expect(normalizeModel('gpt-5.3-codex')).toBe('gpt-5.3-codex');
			expect(normalizeModel('openai/gpt-5.2-codex-high')).toBe('gpt-5.2-codex');
		});

		it('should normalize known gpt-5.x general models', async () => {
			expect(normalizeModel('gpt-5.2')).toBe('gpt-5.2');
			expect(normalizeModel('openai/gpt-5.1-high')).toBe('gpt-5.1');
		});

		it('should leave unknown models untouched', async () => {
			expect(normalizeModel('unknown-model')).toBe('unknown-model');
			expect(normalizeModel('gpt-4')).toBe('gpt-4');
			expect(normalizeModel('gpt-5-codex')).toBe('gpt-5-codex');
			expect(normalizeModel('gpt-5')).toBe('gpt-5');
		});

		it('should default to gpt-5.1 when model is missing', async () => {
			expect(normalizeModel(undefined)).toBe('gpt-5.1');
			expect(normalizeModel('')).toBe('gpt-5.1');
		});

		// Codex CLI preset name tests - gpt-5.x only
		describe('Codex CLI preset names', () => {
			it('should normalize gpt-5.1 codex mini presets', async () => {
				expect(normalizeModel('gpt-5.1-codex-mini')).toBe('gpt-5.1-codex-mini');
				expect(normalizeModel('gpt-5.1-codex-mini-high')).toBe('gpt-5.1-codex-mini');
				expect(normalizeModel('openai/gpt-5.1-codex-mini-medium')).toBe('gpt-5.1-codex-mini');
			});

			it('should normalize gpt-5.1 codex max presets', async () => {
				expect(normalizeModel('gpt-5.1-codex-max')).toBe('gpt-5.1-codex-max');
				expect(normalizeModel('gpt-5.1-codex-max-high')).toBe('gpt-5.1-codex-max');
				expect(normalizeModel('gpt-5.1-codex-max-xhigh')).toBe('gpt-5.1-codex-max');
				expect(normalizeModel('openai/gpt-5.1-codex-max-medium')).toBe('gpt-5.1-codex-max');
			});

				it('should normalize gpt-5.3 and gpt-5.2 codex presets', async () => {
					expect(normalizeModel('gpt-5.2-codex')).toBe('gpt-5.2-codex');
					expect(normalizeModel('gpt-5.2-codex-low')).toBe('gpt-5.2-codex');
					expect(normalizeModel('gpt-5.2-codex-medium')).toBe('gpt-5.2-codex');
					expect(normalizeModel('gpt-5.2-codex-high')).toBe('gpt-5.2-codex');
					expect(normalizeModel('gpt-5.2-codex-xhigh')).toBe('gpt-5.2-codex');
					expect(normalizeModel('openai/gpt-5.2-codex-xhigh')).toBe('gpt-5.2-codex');
					expect(normalizeModel('gpt-5.3-codex')).toBe('gpt-5.3-codex');
					expect(normalizeModel('gpt-5.3-codex-low')).toBe('gpt-5.3-codex');
					expect(normalizeModel('gpt-5.3-codex-medium')).toBe('gpt-5.3-codex');
					expect(normalizeModel('gpt-5.3-codex-high')).toBe('gpt-5.3-codex');
					expect(normalizeModel('gpt-5.3-codex-xhigh')).toBe('gpt-5.3-codex');
					expect(normalizeModel('openai/gpt-5.3-codex')).toBe('gpt-5.3-codex');
					expect(normalizeModel('openai/gpt-5.3-codex-xhigh')).toBe('gpt-5.3-codex');
				});

			it('should normalize gpt-5.1 codex and mini slugs', async () => {
				expect(normalizeModel('gpt-5.1-codex')).toBe('gpt-5.1-codex');
				expect(normalizeModel('openai/gpt-5.1-codex')).toBe('gpt-5.1-codex');
				expect(normalizeModel('gpt-5.1-codex-mini')).toBe('gpt-5.1-codex-mini');
				expect(normalizeModel('gpt-5.1-codex-mini-high')).toBe('gpt-5.1-codex-mini');
				expect(normalizeModel('openai/gpt-5.1-codex-mini-medium')).toBe('gpt-5.1-codex-mini');
			});

			it('should normalize gpt-5.1 general-purpose slugs', async () => {
				expect(normalizeModel('gpt-5.1')).toBe('gpt-5.1');
				expect(normalizeModel('openai/gpt-5.1')).toBe('gpt-5.1');
				expect(normalizeModel('GPT 5.1 High')).toBe('gpt 5.1 high');
			});

			it('should normalize future codex model variants without explicit map entries', async () => {
				expect(normalizeModel('gpt-5.4-codex')).toBe('gpt-5.4-codex');
				expect(normalizeModel('gpt-5.4-codex-low')).toBe('gpt-5.4-codex');
				expect(normalizeModel('gpt-5.4-codex-medium')).toBe('gpt-5.4-codex');
				expect(normalizeModel('gpt-5.4-codex-high')).toBe('gpt-5.4-codex');
				expect(normalizeModel('gpt-5.4-codex-xhigh')).toBe('gpt-5.4-codex');
				expect(normalizeModel('openai/gpt-5.4-codex-xhigh')).toBe('gpt-5.4-codex');
			});
		});

		// Edge case tests - avoid legacy or nonstandard coercion
		describe('Edge cases', () => {
			it('should handle uppercase and mixed case for known models', async () => {
				expect(normalizeModel('GPT-5.3-CODEX')).toBe('gpt-5.3-codex');
				expect(normalizeModel('GpT-5.1-HiGh')).toBe('gpt-5.1');
			});

			it('should not coerce legacy or verbose names', async () => {
				expect(normalizeModel('GPT 5 Codex Low (ChatGPT Subscription)')).toBe(
					'gpt 5 codex low (chatgpt subscription)',
				);
				expect(normalizeModel('my_gpt-5_codex')).toBe('my_gpt-5_codex');
				expect(normalizeModel('gpt.5.high')).toBe('gpt.5.high');
			});
		});
	});

	describe('getModelConfig', () => {
		describe('Per-model options (Bug Fix Verification)', () => {
			it('should find per-model options using config key', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium' },
					models: {
						'gpt-5-codex-low': {
							options: { reasoningEffort: 'low', textVerbosity: 'low' }
						}
					}
				};

				const result = getModelConfig('gpt-5-codex-low', userConfig);
				expect(result.reasoningEffort).toBe('low');
				expect(result.textVerbosity).toBe('low');
			});

			it('should merge global and per-model options (per-model wins)', async () => {
				const userConfig: UserConfig = {
					global: {
						reasoningEffort: 'medium',
						textVerbosity: 'medium',
						include: ['reasoning.encrypted_content']
					},
					models: {
						'gpt-5-codex-high': {
							options: { reasoningEffort: 'high' }  // Override only effort
						}
					}
				};

				const result = getModelConfig('gpt-5-codex-high', userConfig);
				expect(result.reasoningEffort).toBe('high');  // From per-model
				expect(result.textVerbosity).toBe('medium');  // From global
				expect(result.include).toEqual(['reasoning.encrypted_content']);  // From global
			});

			it('should return global options when model not in config', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium' },
					models: {
						'gpt-5-codex-low': { options: { reasoningEffort: 'low' } }
					}
				};

				// Looking up different model
				const result = getModelConfig('gpt-5-codex', userConfig);
				expect(result.reasoningEffort).toBe('medium');  // Global only
			});

			it('should handle empty config', async () => {
				const result = getModelConfig('gpt-5-codex', { global: {}, models: {} });
				expect(result).toEqual({});
			});

			it('should handle missing models object', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'low' },
					models: undefined as any
				};
				const result = getModelConfig('gpt-5', userConfig);
				expect(result.reasoningEffort).toBe('low');
			});
		});

		describe('Backwards compatibility', () => {
			it('should work with old verbose config keys', async () => {
				const userConfig: UserConfig = {
					global: {},
					models: {
						'GPT 5 Codex Low (ChatGPT Subscription)': {
							options: { reasoningEffort: 'low' }
						}
					}
				};

				const result = getModelConfig('GPT 5 Codex Low (ChatGPT Subscription)', userConfig);
				expect(result.reasoningEffort).toBe('low');
			});

			it('should work with old configs that have id field', async () => {
				const userConfig: UserConfig = {
					global: {},
					models: {
						'gpt-5-codex-low': {
							id: 'gpt-5-codex',  // id field present but should be ignored
							options: { reasoningEffort: 'low' }
						}
					}
				};

				const result = getModelConfig('gpt-5-codex-low', userConfig);
				expect(result.reasoningEffort).toBe('low');
			});
		});

		describe('Default models (no custom config)', () => {
			it('should return global options for default gpt-5-codex', async () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'high' },
					models: {}
				};

				const result = getModelConfig('gpt-5-codex', userConfig);
				expect(result.reasoningEffort).toBe('high');
			});

			it('should return empty when no config at all', async () => {
				const result = getModelConfig('gpt-5', undefined);
				expect(result).toEqual({});
			});
		});
	});

	describe('filterInput', () => {
		it('should keep items without IDs unchanged', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: 'hello' },
			];
			const result = filterInput(input);
			expect(result).toEqual(input);
			expect(result![0]).not.toHaveProperty('id');
		});

		it('should remove ALL message IDs (rs_, msg_, etc.) for store:false compatibility', async () => {
			const input: InputItem[] = [
				{ id: 'rs_123', type: 'message', role: 'assistant', content: 'hello' },
				{ id: 'msg_456', type: 'message', role: 'user', content: 'world' },
				{ id: 'assistant_789', type: 'message', role: 'assistant', content: 'test' },
			];
			const result = filterInput(input);

			// All items should remain (no filtering), but ALL IDs removed
			expect(result).toHaveLength(3);
			expect(result![0]).not.toHaveProperty('id');
			expect(result![1]).not.toHaveProperty('id');
			expect(result![2]).not.toHaveProperty('id');
			expect(result![0].content).toBe('hello');
			expect(result![1].content).toBe('world');
			expect(result![2].content).toBe('test');
		});

		it('should strip ID field but preserve all other properties', async () => {
			const input: InputItem[] = [
				{
					id: 'msg_123',
					type: 'message',
					role: 'user',
					content: 'test',
					metadata: { some: 'data' }
				},
			];
			const result = filterInput(input);

			expect(result).toHaveLength(1);
			expect(result![0]).not.toHaveProperty('id');
			expect(result![0].type).toBe('message');
			expect(result![0].role).toBe('user');
			expect(result![0].content).toBe('test');
			expect(result![0]).toHaveProperty('metadata');
		});

		it('should handle mixed items with and without IDs', async () => {
			const input: InputItem[] = [
				{ type: 'message', role: 'user', content: '1' },
				{ id: 'rs_stored', type: 'message', role: 'assistant', content: '2' },
				{ id: 'msg_123', type: 'message', role: 'user', content: '3' },
			];
			const result = filterInput(input);

			// All items kept, IDs removed from items that had them
			expect(result).toHaveLength(3);
			expect(result![0]).not.toHaveProperty('id');
			expect(result![1]).not.toHaveProperty('id');
			expect(result![2]).not.toHaveProperty('id');
			expect(result![0].content).toBe('1');
			expect(result![1].content).toBe('2');
			expect(result![2].content).toBe('3');
		});

		it('should handle custom ID formats (future-proof)', async () => {
			const input: InputItem[] = [
				{ id: 'custom_id_format', type: 'message', role: 'user', content: 'test' },
				{ id: 'another-format-123', type: 'message', role: 'user', content: 'test2' },
			];
			const result = filterInput(input);

			expect(result).toHaveLength(2);
			expect(result![0]).not.toHaveProperty('id');
			expect(result![1]).not.toHaveProperty('id');
		});

		it('should return undefined for undefined input', async () => {
			expect(filterInput(undefined)).toBeUndefined();
		});

		it('should return non-array input as-is', async () => {
			const notArray = { notAnArray: true };
			expect(filterInput(notArray as any)).toBe(notArray);
		});

		it('should handle empty array', async () => {
			const input: InputItem[] = [];
			const result = filterInput(input);
			expect(result).toEqual([]);
		});
	});

		describe('transformRequestBody', () => {
			const codexInstructions = 'Test Codex Instructions';

			it('preserves existing prompt_cache_key passed by host (OpenCode)', async () => {
				const body: RequestBody = {
					model: 'gpt-5-codex',
					input: [],
					// Host-provided key (OpenCode session id)
					prompt_cache_key: 'ses_host_key_123',
				};
				const result: any = await transformRequestBody(body, codexInstructions);
				expect(result.prompt_cache_key).toBe('ses_host_key_123');
			});

			it('leaves prompt_cache_key unset when host does not supply one', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [],
				};
				const result: any = await transformRequestBody(body, codexInstructions);
				expect(result.prompt_cache_key).toBeUndefined();
			});

		it('should set required Codex fields', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);

			expect(result.store).toBe(false);
			expect(result.stream).toBe(true);
			expect(result.instructions).toContain(codexInstructions);
		});

		it('should normalize model name', async () => {
			const body: RequestBody = {
				model: 'gpt-5-mini',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.model).toBe('gpt-5-mini');
		});

		it('should apply default reasoning config', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);

			expect(result.reasoning?.effort).toBe('medium');
			expect(result.reasoning?.summary).toBe('auto');
		});

		it('should apply user reasoning config', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const userConfig: UserConfig = {
				global: {
					reasoningEffort: 'high',
					reasoningSummary: 'detailed',
				},
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);

			expect(result.reasoning?.effort).toBe('high');
			expect(result.reasoning?.summary).toBe('detailed');
		});

		it('should respect reasoning config already set in body', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				reasoning: {
					effort: 'low',
					summary: 'auto',
				},
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'high', reasoningSummary: 'detailed' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);

			expect(result.reasoning?.effort).toBe('low');
			expect(result.reasoning?.summary).toBe('auto');
		});

		it('should use reasoning config from providerOptions when present', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				providerOptions: {
					openai: {
						reasoningEffort: 'high',
						reasoningSummary: 'detailed',
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions);

			expect(result.reasoning?.effort).toBe('high');
			expect(result.reasoning?.summary).toBe('detailed');
		});

		it('should apply default text verbosity', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.text?.verbosity).toBe('medium');
		});

		it('should apply user text verbosity', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { textVerbosity: 'low' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.text?.verbosity).toBe('low');
		});

		it('should use text verbosity from providerOptions when present', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				providerOptions: {
					openai: {
						textVerbosity: 'low',
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.text?.verbosity).toBe('low');
		});

		it('should prefer body text verbosity over providerOptions', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				text: { verbosity: 'high' },
				providerOptions: {
					openai: {
						textVerbosity: 'low',
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.text?.verbosity).toBe('high');
		});

		it('should set default include for encrypted reasoning', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.include).toEqual(['reasoning.encrypted_content']);
		});

		it('should use user-configured include', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { include: ['custom_field', 'reasoning.encrypted_content'] },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.include).toEqual(['custom_field', 'reasoning.encrypted_content']);
		});

		it('should always include reasoning.encrypted_content when include provided', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				include: ['custom_field'],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.include).toEqual(['custom_field', 'reasoning.encrypted_content']);
		});

		it('should remove IDs from input array (keep all items, strip IDs)', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [
					{ id: 'rs_123', type: 'message', role: 'assistant', content: 'old' },
					{ type: 'message', role: 'user', content: 'new' },
				],
			};
			const result = await transformRequestBody(body, codexInstructions);

			// All items kept, IDs removed
			expect(result.input).toHaveLength(2);
			expect(result.input![0]).not.toHaveProperty('id');
			expect(result.input![1]).not.toHaveProperty('id');
			expect(result.input![0].content).toBe('old');
			expect(result.input![1].content).toBe('new');
		});

		it('should not prepend bridge or tool-remap message when tools are present', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [{ type: 'message', role: 'user', content: 'hello' }],
				tools: [{ name: 'test_tool' }],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.input).toHaveLength(1);
			expect(result.input![0].role).toBe('user');
		});

		it('should not add tool remap message when tools absent', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [{ type: 'message', role: 'user', content: 'hello' }],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.input![0].role).toBe('user');
		});

		it('should remove unsupported parameters', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
				max_output_tokens: 1000,
				max_completion_tokens: 2000,
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.max_output_tokens).toBeUndefined();
			expect(result.max_completion_tokens).toBeUndefined();
		});

		it('should normalize minimal to low for gpt-5-codex', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'minimal' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should clamp xhigh to high for codex-mini', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-mini-high',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'xhigh' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.reasoning?.effort).toBe('high');
		});

		it('should clamp none to medium for codex-mini', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-mini-medium',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.reasoning?.effort).toBe('medium');
		});

		it('should default codex-max to high effort', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-max',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.reasoning?.effort).toBe('high');
		});

		it('should default gpt-5.2-codex to high effort', async () => {
			const body: RequestBody = {
				model: 'gpt-5.2-codex',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.model).toBe('gpt-5.2-codex');
			expect(result.reasoning?.effort).toBe('high');
		});

		it('should preserve xhigh for codex-max when requested', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-max-xhigh',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningSummary: 'auto' },
				models: {
					'gpt-5.1-codex-max-xhigh': {
						options: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' },
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1-codex-max');
			expect(result.reasoning?.effort).toBe('xhigh');
			expect(result.reasoning?.summary).toBe('detailed');
		});

		it('should preserve xhigh for gpt-5.2-codex when requested', async () => {
			const body: RequestBody = {
				model: 'gpt-5.2-codex-xhigh',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningSummary: 'auto' },
				models: {
					'gpt-5.2-codex-xhigh': {
						options: { reasoningEffort: 'xhigh', reasoningSummary: 'detailed' },
					},
				},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.2-codex');
			expect(result.reasoning?.effort).toBe('xhigh');
			expect(result.reasoning?.summary).toBe('detailed');
		});

		it('should downgrade xhigh to high for non-max codex', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-high',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'xhigh' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1-codex');
			expect(result.reasoning?.effort).toBe('high');
		});

		it('should downgrade xhigh to high for non-max general models', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-high',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'xhigh' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1');
			expect(result.reasoning?.effort).toBe('high');
		});

		it('should preserve none for GPT-5.2', async () => {
			const body: RequestBody = {
				model: 'gpt-5.2-none',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.2');
			expect(result.reasoning?.effort).toBe('none');
		});

		it('should upgrade none to low for GPT-5.2-codex (codex does not support none)', async () => {
			const body: RequestBody = {
				model: 'gpt-5.2-codex',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.2-codex');
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should normalize minimal to low for gpt-5.2-codex', async () => {
			const body: RequestBody = {
				model: 'gpt-5.2-codex',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'minimal' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.2-codex');
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should preserve none for GPT-5.1 general purpose', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-none',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1');
			expect(result.reasoning?.effort).toBe('none');
		});

		it('should upgrade none to low for GPT-5.1-codex (codex does not support none)', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1-codex');
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should upgrade none to low for GPT-5.1-codex-max (codex max does not support none)', async () => {
			const body: RequestBody = {
				model: 'gpt-5.1-codex-max',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'none' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.model).toBe('gpt-5.1-codex-max');
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should normalize minimal to low for non-codex models', async () => {
			const body: RequestBody = {
				model: 'gpt-5',
				input: [],
			};
			const userConfig: UserConfig = {
				global: { reasoningEffort: 'minimal' },
				models: {},
			};
			const result = await transformRequestBody(body, codexInstructions, userConfig);
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should use minimal effort for lightweight models', async () => {
			const body: RequestBody = {
				model: 'gpt-5-nano',
				input: [],
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should normalize minimal to low when provided by the host', async () => {
			const body: RequestBody = {
				model: 'gpt-5-nano',
				input: [],
				reasoning: { effort: 'minimal' },
			};
			const result = await transformRequestBody(body, codexInstructions);
			expect(result.reasoning?.effort).toBe('low');
		});

		it('should convert orphaned function_call_output to message to preserve context', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{ type: 'function_call_output', role: 'assistant', call_id: 'orphan_call', name: 'read', output: '{}' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.tools).toBeUndefined();
			expect(result.input).toHaveLength(2);
			expect(result.input![0].type).toBe('message');
			expect(result.input![1].type).toBe('message');
			expect(result.input![1].role).toBe('assistant');
			expect(result.input![1].content).toContain('[Previous read result; call_id=orphan_call]');
		});

		it('should keep matched function_call pairs when no tools present (for compaction)', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{ type: 'function_call', call_id: 'call_1', name: 'write', arguments: '{}' } as any,
					{ type: 'function_call_output', call_id: 'call_1', output: 'success' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.tools).toBeUndefined();
			expect(result.input).toHaveLength(3);
			expect(result.input![1].type).toBe('function_call');
			expect(result.input![2].type).toBe('function_call_output');
		});

		it('should treat local_shell_call as a match for function_call_output', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{
						type: 'local_shell_call',
						call_id: 'shell_call',
						action: { type: 'exec', command: ['ls'] },
					} as any,
					{ type: 'function_call_output', call_id: 'shell_call', output: 'ok' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.input).toHaveLength(3);
			expect(result.input![1].type).toBe('local_shell_call');
			expect(result.input![2].type).toBe('function_call_output');
		});

		it('should keep matching custom_tool_call_output items', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{
						type: 'custom_tool_call',
						call_id: 'custom_call',
						name: 'mcp_tool',
						input: '{}',
					} as any,
					{ type: 'custom_tool_call_output', call_id: 'custom_call', output: 'done' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.input).toHaveLength(3);
			expect(result.input![1].type).toBe('custom_tool_call');
			expect(result.input![2].type).toBe('custom_tool_call_output');
		});

		it('should convert orphaned custom_tool_call_output to message', async () => {
			const body: RequestBody = {
				model: 'gpt-5-codex',
				input: [
					{ type: 'message', role: 'user', content: 'hello' },
					{ type: 'custom_tool_call_output', call_id: 'orphan_custom', output: 'oops' } as any,
				],
			};

			const result = await transformRequestBody(body, codexInstructions);

			expect(result.input).toHaveLength(2);
			expect(result.input![1].type).toBe('message');
			expect(result.input![1].content).toContain('[Previous tool result; call_id=orphan_custom]');
		});

		describe('bridge removal parity', () => {
			it('does not inject bridge content when tools are present', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [{ type: 'message', role: 'user', content: 'hello' }],
					tools: [{ name: 'test_tool' }],
				};
				const result = await transformRequestBody(body, codexInstructions);

				expect(result.input).toHaveLength(1);
				expect(result.input![0].role).toBe('user');
			});

			it('preserves OpenCode environment/AGENTS-style developer messages', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [
						{
							type: 'message',
							role: 'developer',
							content: [
								'Here is some useful information about the environment you are running in:',
								'<env>',
								'  Working directory: /tmp/project',
								'</env>',
								'Instructions from: /tmp/project/AGENTS.md',
								'# Project Guidelines',
							].join('\n'),
						},
						{ type: 'message', role: 'user', content: 'hello' },
					],
					tools: [{ name: 'test_tool' }],
				};
				const result = await transformRequestBody(body, codexInstructions);

				expect(result.input).toHaveLength(2);
				expect(result.input![0].role).toBe('developer');
				expect(String(result.input![0].content)).toContain('Working directory');
				expect(String(result.input![0].content)).toContain('Instructions from: /tmp/project/AGENTS.md');
				expect(result.input![1].role).toBe('user');
			});

			it('keeps codex instructions as canonical instructions field', async () => {
				const body: RequestBody = {
					model: 'gpt-5',
					input: [{ type: 'message', role: 'user', content: 'hello' }],
					tools: [{ name: 'test_tool' }],
				};
				const result = await transformRequestBody(body, codexInstructions);
				expect(result.instructions).toContain(codexInstructions);
			});
		});

		describe('personality resolution', () => {
			it('applies custom personality from local file', async () => {
				const root = mkdtempSync(join(tmpdir(), 'personality-local-'));
				const cwd = process.cwd();
				process.chdir(root);
				try {
					const localDir = join(root, '.opencode', 'Personalities');
					mkdirSync(localDir, { recursive: true });
					writeFileSync(
						join(localDir, 'Idiot.md'),
						'Chaotic friendly override',
						'utf8',
					);
					const body: RequestBody = {
						model: 'gpt-5.3-codex',
						input: [],
					};
					const userConfig: UserConfig = { global: {}, models: {} };
					const pluginConfig = {
						custom_settings: {
							options: { personality: 'Idiot' },
							models: {},
						},
					};
					const runtimeDefaults = {
						instructionsTemplate: 'BASE INSTRUCTIONS\n\n{{ personality }}',
						personalityMessages: {
							friendly: 'Friendly from runtime',
							pragmatic: 'Pragmatic from runtime',
						},
						staticDefaultPersonality: 'pragmatic',
					};
					const result = await transformRequestBody(
						body,
						'BASE INSTRUCTIONS',
						userConfig,
						runtimeDefaults as any,
						pluginConfig as any,
					);
					expect(result.instructions).toContain('Chaotic friendly override');
				} finally {
					process.chdir(cwd);
					rmSync(root, { recursive: true, force: true });
				}
			});

			it('defaults to pragmatic when no custom personality set', async () => {
				const body: RequestBody = {
					model: 'gpt-5.3-codex',
					input: [],
				};
				const userConfig: UserConfig = { global: {}, models: {} };
				const runtimeDefaults = {
					instructionsTemplate: 'BASE INSTRUCTIONS\n\n{{ personality }}',
					personalityMessages: {
						friendly: 'Friendly from runtime',
						pragmatic: 'Pragmatic from runtime',
					},
					staticDefaultPersonality: 'pragmatic',
				};
				const result = await transformRequestBody(
					body,
					'BASE INSTRUCTIONS',
					userConfig,
					runtimeDefaults as any,
					{} as any,
				);
				expect(result.instructions).toContain('Pragmatic from runtime');
			});

			it('logs invalid personality once per process while coercing to pragmatic', async () => {
				const previousLogging = process.env.ENABLE_PLUGIN_REQUEST_LOGGING;
				process.env.ENABLE_PLUGIN_REQUEST_LOGGING = '1';
				const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

				try {
					vi.resetModules();
					const dynamicModule = await import('../lib/request/request-transformer.js');
					const dynamicTransform = dynamicModule.transformRequestBody;
					const body: RequestBody = {
						model: 'gpt-5.3-codex',
						input: [],
					};
					const userConfig: UserConfig = {
						global: {},
						models: {},
					};
					const pluginConfig = {
						custom_settings: {
							options: { personality: 'INVALID' },
							models: {},
						},
					};

					await dynamicTransform(
						body,
						'BASE INSTRUCTIONS',
						userConfig,
						undefined,
						pluginConfig as any,
					);
					await dynamicTransform(
						body,
						'BASE INSTRUCTIONS',
						userConfig,
						undefined,
						pluginConfig as any,
					);

					const invalidLogs = logSpy.mock.calls.filter((call) =>
						call.some((part) =>
							String(part).includes('Invalid personality "INVALID" detected; coercing to "pragmatic"'),
						),
					);
					expect(invalidLogs).toHaveLength(1);
				} finally {
					if (previousLogging === undefined) {
						delete process.env.ENABLE_PLUGIN_REQUEST_LOGGING;
					} else {
						process.env.ENABLE_PLUGIN_REQUEST_LOGGING = previousLogging;
					}
					vi.restoreAllMocks();
					vi.resetModules();
				}
			});
		});

		// NEW: Integration tests for all config scenarios
		describe('Integration: Complete Config Scenarios', () => {
			describe('Scenario 1: Default models (no custom config)', () => {
			it('should handle gpt-5-codex with global options only', async () => {
				const body: RequestBody = {
					model: 'gpt-5-codex',
					input: []
				};
					const userConfig: UserConfig = {
						global: { reasoningEffort: 'high' },
						models: {}
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('high');  // From global
				expect(result.store).toBe(false);
			});

			it('should handle gpt-5-mini normalizing to gpt-5.1', async () => {
				const body: RequestBody = {
					model: 'gpt-5-mini',
					input: []
				};

					const result = await transformRequestBody(body, codexInstructions);

				expect(result.model).toBe('gpt-5-mini');
				expect(result.reasoning?.effort).toBe('low');  // Lightweight defaults
			});
			});

			describe('Scenario 2: Custom preset names (new style)', () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium', include: ['reasoning.encrypted_content'] },
					models: {
						'gpt-5-codex-low': {
							options: { reasoningEffort: 'low' }
						},
						'gpt-5-codex-high': {
							options: { reasoningEffort: 'high', reasoningSummary: 'detailed' }
						}
					}
				};

			it('should apply per-model options for gpt-5-codex-low', async () => {
				const body: RequestBody = {
					model: 'gpt-5-codex-low',
					input: []
				};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

				expect(result.model).toBe('gpt-5-codex-low');
				expect(result.reasoning?.effort).toBe('low');  // From per-model
				expect(result.include).toEqual(['reasoning.encrypted_content']);  // From global
			});

			it('should apply per-model options for gpt-5-codex-high', async () => {
				const body: RequestBody = {
					model: 'gpt-5-codex-high',
					input: []
				};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

				expect(result.model).toBe('gpt-5-codex-high');
				expect(result.reasoning?.effort).toBe('high');  // From per-model
				expect(result.reasoning?.summary).toBe('detailed');  // From per-model
			});

			it('should use global options for default gpt-5-codex', async () => {
				const body: RequestBody = {
					model: 'gpt-5-codex',
					input: []
				};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

				expect(result.model).toBe('gpt-5-codex');
				expect(result.reasoning?.effort).toBe('medium');  // From global (no per-model)
			});
			});

			describe('Scenario 3: Backwards compatibility (old verbose names)', () => {
				const userConfig: UserConfig = {
					global: {},
					models: {
						'GPT 5 Codex Low (ChatGPT Subscription)': {
							options: { reasoningEffort: 'low', textVerbosity: 'low' }
						}
					}
				};

			it('should find and apply old config format', async () => {
				const body: RequestBody = {
					model: 'GPT 5 Codex Low (ChatGPT Subscription)',
					input: []
				};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

				expect(result.model).toBe('gpt 5 codex low (chatgpt subscription)');
				expect(result.reasoning?.effort).toBe('low');  // From per-model (old format)
				expect(result.text?.verbosity).toBe('low');
			});
			});

			describe('Scenario 4: Mixed default + custom models', () => {
				const userConfig: UserConfig = {
					global: { reasoningEffort: 'medium' },
					models: {
						'gpt-5-codex-low': {
							options: { reasoningEffort: 'low' }
						}
					}
				};

				it('should use per-model for custom variant', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex-low',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.reasoning?.effort).toBe('low');  // Per-model
				});

				it('should use global for default model', async () => {
					const body: RequestBody = {
						model: 'gpt-5',
						input: []
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

					expect(result.reasoning?.effort).toBe('medium');  // Global
				});
			});

			describe('Scenario 5: Message ID filtering with multi-turn', () => {
				it('should remove ALL IDs in multi-turn conversation', async () => {
					const body: RequestBody = {
						model: 'gpt-5-codex',
						input: [
							{ id: 'msg_turn1', type: 'message', role: 'user', content: 'first' },
							{ id: 'rs_response1', type: 'message', role: 'assistant', content: 'response' },
							{ id: 'msg_turn2', type: 'message', role: 'user', content: 'second' },
							{ id: 'assistant_123', type: 'message', role: 'assistant', content: 'reply' },
						]
					};

					const result = await transformRequestBody(body, codexInstructions);

					// All items kept, ALL IDs removed
					expect(result.input).toHaveLength(4);
					expect(result.input!.every(item => !item.id)).toBe(true);
					expect(result.store).toBe(false);  // Stateless mode
					expect(result.include).toEqual(['reasoning.encrypted_content']);
				});
			});

			describe('Scenario 6: Complete end-to-end transformation', () => {
				it('should handle full transformation: custom model + IDs + tools', async () => {
					const userConfig: UserConfig = {
						global: { include: ['reasoning.encrypted_content'] },
						models: {
							'gpt-5-codex-low': {
								options: {
									reasoningEffort: 'low',
									textVerbosity: 'low',
									reasoningSummary: 'auto'
								}
							}
						}
					};

					const body: RequestBody = {
						model: 'gpt-5-codex-low',
						input: [
							{ id: 'msg_1', type: 'message', role: 'user', content: 'test' },
							{ id: 'rs_2', type: 'message', role: 'assistant', content: 'reply' }
						],
						tools: [{ name: 'edit' }]
					};

					const result = await transformRequestBody(body, codexInstructions, userConfig);

				// Model preserved for legacy identifiers
				expect(result.model).toBe('gpt-5-codex-low');

					// IDs removed
					expect(result.input!.every(item => !item.id)).toBe(true);

					// Per-model options applied
					expect(result.reasoning?.effort).toBe('low');
					expect(result.reasoning?.summary).toBe('auto');
					expect(result.text?.verbosity).toBe('low');

				// Codex fields set
				expect(result.store).toBe(false);
				expect(result.stream).toBe(true);
				expect(result.instructions).toContain(codexInstructions);
				expect(result.include).toEqual(['reasoning.encrypted_content']);
			});
			});
		});
	});
});
