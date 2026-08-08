import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';

import { AppModule } from '@app/app.module';

/**
 * Pins the OpenAPI schema to the envelope the wire actually carries — the Phase 5
 * audit found /docs documenting the unwrapped shape, and a schema nobody asserts
 * drifts exactly the way that prose did.
 */
describe('OpenAPI document (e2e)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  const schemaOf = (
    path: string,
    method: 'get' | 'post',
    status: string,
  ): Record<string, unknown> => {
    const operation = (document.paths[path] as Record<string, unknown>)[method] as {
      responses: Record<string, { content?: Record<string, { schema: Record<string, unknown> }> }>;
    };
    return operation.responses[status].content?.['application/json']?.schema ?? {};
  };

  const isEnveloped = (schema: Record<string, unknown>): boolean => {
    const allOf = schema.allOf as Array<Record<string, unknown>> | undefined;
    if (!allOf || allOf.length !== 2) {
      return false;
    }
    const refsEnvelope = allOf[0].$ref === '#/components/schemas/ResponseEnvelopeDto';
    const dataProp = (allOf[1].properties as Record<string, unknown> | undefined)?.data;
    return refsEnvelope && dataProp !== undefined;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents the envelope base with statusCode and timestamp', () => {
    const envelope = (document.components?.schemas?.ResponseEnvelopeDto ?? {}) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(envelope.properties ?? {})).toEqual(
      expect.arrayContaining(['statusCode', 'timestamp']),
    );
  });

  it('POST /locations 201 is enveloped around LocationReportResponseDto', () => {
    const schema = schemaOf('/locations', 'post', '201');
    expect(isEnveloped(schema)).toBe(true);
    const data = (
      (schema.allOf as Array<Record<string, unknown>>)[1].properties as Record<string, unknown>
    ).data as Record<string, unknown>;
    expect(data.$ref).toBe('#/components/schemas/LocationReportResponseDto');
  });

  it('GET /areas 200 is enveloped around an ARRAY of AreaResponseDto', () => {
    const schema = schemaOf('/areas', 'get', '200');
    expect(isEnveloped(schema)).toBe(true);
    const data = (
      (schema.allOf as Array<Record<string, unknown>>)[1].properties as Record<string, unknown>
    ).data as { type?: string; items?: { $ref?: string } };
    expect(data.type).toBe('array');
    expect(data.items?.$ref).toBe('#/components/schemas/AreaResponseDto');
  });

  it('POST /areas 201 is enveloped around AreaResponseDto', () => {
    expect(isEnveloped(schemaOf('/areas', 'post', '201'))).toBe(true);
  });

  it('GET /logs 200 is enveloped around LogsPageResponseDto (items + nextCursor inside data)', () => {
    const schema = schemaOf('/logs', 'get', '200');
    expect(isEnveloped(schema)).toBe(true);
    const page = (document.components?.schemas?.LogsPageResponseDto ?? {}) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(page.properties ?? {})).toEqual(
      expect.arrayContaining(['items', 'nextCursor']),
    );
  });

  it('GET /health is NOT enveloped — it documents the raw shape', () => {
    const schema = schemaOf('/health', 'get', '200');
    expect(isEnveloped(schema)).toBe(false);
  });

  it('error responses reference the house ErrorResponseDto', () => {
    const badRequest = schemaOf('/locations', 'post', '400');
    expect(badRequest.$ref).toBe('#/components/schemas/ErrorResponseDto');
    const unavailable = schemaOf('/locations', 'post', '503');
    expect(unavailable.$ref).toBe('#/components/schemas/ErrorResponseDto');
  });
});
