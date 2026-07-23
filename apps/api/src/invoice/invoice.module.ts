import { Module } from '@nestjs/common';
import { AdminInvoiceController, AdminInvoiceService } from './admin-invoice.controller';
import { INVOICE_REFUND_LINK, InvoiceService } from './invoice.service';
import { OwnerInvoiceController } from './owner-invoice.controller';

@Module({
  controllers: [OwnerInvoiceController, AdminInvoiceController],
  providers: [
    InvoiceService,
    AdminInvoiceService,
    { provide: INVOICE_REFUND_LINK, useExisting: InvoiceService },
  ],
  exports: [InvoiceService, INVOICE_REFUND_LINK],
})
export class InvoiceModule {}
