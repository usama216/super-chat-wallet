import { HttpException, HttpStatus } from '@nestjs/common';

/** 402 with a stable `error` name clients can match on. */
export class InsufficientFundsException extends HttpException {
  constructor(balance: number, amount: number) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'InsufficientFunds',
        message: `Balance ${balance} is less than ${amount}`,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
