import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

import { ResponseEnvelopeDto } from '../dto';

interface ApiEnvelopedResponseOptions {
  status?: number;
  isArray?: boolean;
  description?: string;
}

/**
 * Declares "this endpoint returns `model`, wrapped in the response envelope" — the
 * shape the wire has carried since Phase 0 and /docs misrepresented until Phase 5's
 * audit caught it. One decorator per endpoint; `isArray` covers GET /areas
 * (array inside data) and plain model covers paginated shapes whose page object IS
 * the model (GET /logs). Endpoints with @SkipResponseTransform (health) must NOT
 * use this.
 */
export const ApiEnvelopedResponse = <TModel extends Type<unknown>>(
  model: TModel,
  options: ApiEnvelopedResponseOptions = {},
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    ApiExtraModels(ResponseEnvelopeDto, model),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ResponseEnvelopeDto) },
          {
            type: 'object',
            properties: {
              data: options.isArray
                ? { type: 'array', items: { $ref: getSchemaPath(model) } }
                : { $ref: getSchemaPath(model) },
            },
            required: ['data'],
          },
        ],
      },
    }),
  );
