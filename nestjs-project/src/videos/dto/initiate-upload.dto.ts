import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class InitiateUploadDto {
  /** Human-readable video title. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  /** Original file name (used to build the storage key and download header). */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /** MIME type; must be a `video/*` type (enforced in the service). */
  @IsString()
  @IsNotEmpty()
  mimeType: string;

  /** Declared file size in bytes; the 10GB ceiling is enforced in the service. */
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
