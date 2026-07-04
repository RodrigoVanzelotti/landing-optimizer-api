import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';

/**
 * Validates and narrows request payloads with a Zod schema. Use as
 * `@Body(new ZodValidationPipe(MySchema))`. On failure returns a 400 with the
 * flattened field errors (contract: docs/API_CONTRACTS.md §C).
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          message: 'Validation failed',
          errors: err.flatten().fieldErrors,
        });
      }
      throw new BadRequestException('Validation failed');
    }
  }
}
