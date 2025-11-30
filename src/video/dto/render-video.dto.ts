import { IsString, IsArray, IsNumber, IsNotEmpty } from 'class-validator';

export class RenderVideoDto {
  @IsString()
  @IsNotEmpty()
  audioUrl: string;

  @IsArray()
  @IsString({ each: true })
  images: string[];

  @IsNumber()
  duration: number;
}