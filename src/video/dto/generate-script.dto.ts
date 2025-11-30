import { IsString, IsNotEmpty } from 'class-validator';

export class GenerateScriptDto {
  @IsString()
  @IsNotEmpty()
  prompt: string;
}