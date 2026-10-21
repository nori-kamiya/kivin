import { ApiResponse, Controller, Description, Get, Summary } from '@kivin/decorators';
import { UserSchema } from './schemas';

// 非 ASCII 文字の後ろにある式も、元のソースどおりに切り出せること
@Controller('/ユーザー')
export class UserController {
  @Get('/')
  @Summary('ユーザー一覧 🚀')
  @Description('説明文')
  @ApiResponse(200, UserSchema, '成功')
  list() {
    return [];
  }
}
