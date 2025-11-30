import { IsString, IsNotEmpty } from 'class-validator';

export class GenerateCaptionsDto {
  @IsString()
  @IsNotEmpty()
  audioFileUrl: string;
}