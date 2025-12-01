import { IsString, IsNotEmpty } from 'class-validator';

export class RenderVideoDto {
  @IsString()
  @IsNotEmpty()
  videoId: string;
}