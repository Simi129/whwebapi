import { IsArray, IsString } from 'class-validator';

export class GenerateImagesDto {
  @IsArray()
  @IsString({ each: true })
  prompts: string[];
}