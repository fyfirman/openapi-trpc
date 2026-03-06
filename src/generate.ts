import { zodToJsonSchema } from 'zod-to-json-schema'
import { DummyProcedure, DummyRouter } from './dummyRouter'
import {
  z,
  AnyZodObject,
  ZodType,
  ZodFirstPartyTypeKind,
  ZodArray,
  ZodTypeAny,
} from 'zod'
import { OpenAPIV3 } from 'openapi-types'
import { OperationMeta, allowedOperationKeys } from './meta'
import { RootConfig, Router, RouterDef } from '@trpc/server'

/**
 * @public
 */
export function generateOpenAPIDocumentFromTRPCRouter<R extends Router<any>>(
  inRouter: R,
  options: GenerateOpenAPIDocumentOptions<MetaOf<R>> = {},
) {
  const router: DummyRouter = inRouter as unknown as DummyRouter
  const procs = router._def.procedures
  const paths: OpenAPIV3.PathsObject = {}
  const processOperation = (
    op: OpenAPIV3.OperationObject,
    meta: MetaOf<R>,
  ): OpenAPIV3.OperationObject => {
    return options.processOperation?.(op, meta) || op
  }
  for (const [procName, proc] of Object.entries(procs)) {
    const procDef = proc._def as unknown as DummyProcedure

    // ZodArrays are also correct, as .splice(1) will return an empty array
    // it's ok just to return the array itself
    const input =
      getZodTypeName(procDef.inputs[0]) === ZodFirstPartyTypeKind.ZodArray
        ? (procDef.inputs[0] as ZodArray<ZodTypeAny>)
        : procDef.inputs
            .slice(1)
            .reduce<AnyZodObject>(
              (acc, cur) => asZodObject(acc).merge(asZodObject(cur)),
              asZodObject(procDef.inputs[0] || z.object({})),
            )
    const output = procDef.output
    const inputSchema = toJsonSchema(input)
    const outputSchema = output
      ? toJsonSchema(
          z.object({
            result: z.object({
              data: asZodType(output),
            }),
          }),
        )
      : undefined
    const key = [
      '',
      ...(options.pathPrefix || '/').split('/').filter(Boolean),
      procName,
    ].join('/')
    const responses = {
      200: {
        description: (output && asZodType(output).description) || '',
        ...(outputSchema
          ? {
              content: {
                'application/json': {
                  schema: outputSchema as any,
                },
              },
            }
          : {}),
      },
    }
    const operationInfo: Partial<OpenAPIV3.OperationObject> = {
      tags: procName.split('.').slice(0, -1).slice(0, 1),
    }
    for (const key of allowedOperationKeys) {
      const value = procDef.meta?.[key]
      if (value) {
        operationInfo[key] = value as any
      }
    }
    // Support both tRPC v10 (procDef.query) and v11+ (procDef.type)
    const isQuery = procDef.query || (procDef as any).type === 'query'

    const inputExample = generateExample(inputSchema as Record<string, unknown>)
    const wrappedExample = { json: inputExample }

    if (isQuery) {
      paths[key] = {
        get: processOperation(
          {
            ...operationInfo,
            operationId: procName,
            responses,
            parameters: [
              {
                in: 'query',
                name: 'input',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        json: inputSchema as any,
                      },
                      required: ['json'],
                    } as any,
                    example: wrappedExample,
                  },
                },
              },
            ],
          },
          procDef.meta as any,
        ),
      }
    } else {
      paths[key] = {
        post: processOperation(
          {
            ...operationInfo,
            operationId: procName,
            responses,
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      json: inputSchema as any,
                    },
                    required: ['json'],
                  } as any,
                  example: wrappedExample,
                },
              },
            },
          },
          procDef.meta as any,
        ),
      }
    }
  }
  const api: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: {
      title: options.title ?? 'tRPC HTTP-RPC',
      version: options.version ?? '',
      ...(options.description ? { description: options.description } : {}),
    },
    paths,
  }
  return api
}

function getZodTypeName(input: unknown) {
  return (input as { _def?: { typeName?: string } } | undefined)?._def?.typeName
}

function asZodObject(input: unknown) {
  if (
    getZodTypeName(input) !== ZodFirstPartyTypeKind.ZodObject &&
    getZodTypeName(input) !== ZodFirstPartyTypeKind.ZodVoid &&
    getZodTypeName(input) !== ZodFirstPartyTypeKind.ZodOptional
  ) {
    throw new Error('Expected a ZodObject, received: ' + String(input))
  }
  return input as AnyZodObject
}

function asZodType(input: unknown) {
  if (!getZodTypeName(input)) {
    throw new Error('Expected a Zod schema, received: ' + String(input))
  }
  return input as ZodType
}

/**
 * @public
 */
export interface GenerateOpenAPIDocumentOptions<M extends OperationMeta> {
  title?: string
  version?: string
  description?: string
  pathPrefix?: string
  processOperation?: (
    operation: OpenAPIV3.OperationObject,
    meta: M | undefined,
  ) => OpenAPIV3.OperationObject | void
}

function toJsonSchema(input: ZodType) {
  const { $schema, ...output } = zodToJsonSchema(input)
  return output
}

function generateExample(schema: Record<string, unknown>): unknown {
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0]

  switch (schema.type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return true
    case 'array':
      return []
    case 'object': {
      if (!schema.properties) return {}
      const result: Record<string, unknown> = {}
      for (const [key, prop] of Object.entries(
        schema.properties as Record<string, Record<string, unknown>>,
      )) {
        result[key] = generateExample(prop)
      }
      return result
    }
    default:
      return undefined
  }
}

type MetaOf<R extends Router<any>> = R extends Router<RouterDef<infer D, any>>
  ? D extends RootConfig<infer C>
    ? C['meta']
    : never
  : never
