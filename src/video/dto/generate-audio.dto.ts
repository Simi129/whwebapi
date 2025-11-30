import { IsString, IsNotEmpty } from 'class-validator';

export class GenerateAudioDto {
  @IsString()
  @IsNotEmpty()
  text: string;
}