import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadPartDto {
  /** 1-based index of the multipart part this ETag belongs to. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag returned by storage for the uploaded part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** The ETags of every uploaded part, used to assemble the final object. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
