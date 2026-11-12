import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { upload } from '../../middleware/upload.js';
import * as s from './leads.schemas.js';
import * as ctrl from './leads.controller.js';

/** /leads — pipeline, lead detail, activities, quotes, documents, bulk, merge, duplicates, CSV export. */
const router = Router();

router.get('/', authorize('leads', 'v'), validate({ query: s.listQuery }), ctrl.list);
router.get('/export.csv', authorize('leads', 'v'), validate({ query: s.exportQuery }), ctrl.exportCsv);
router.get('/duplicates', authorize('leads', 'v'), validate({ query: s.duplicatesQuery }), ctrl.duplicates);
router.post('/', authorize('leads', 'c'), validate({ body: s.createLeadSchema }), ctrl.create);
router.post('/bulk', authorize('leads', 'e'), validate({ body: s.bulkSchema }), ctrl.bulk);
router.post('/merge', authorize('leads', 'e'), validate({ body: s.mergeSchema }), ctrl.merge);

router.get('/:id', authorize('leads', 'v'), validate({ params: s.idParams }), ctrl.get);
router.patch('/:id', authorize('leads', 'e'), validate({ params: s.idParams, body: s.updateLeadSchema }), ctrl.update);
router.patch('/:id/status', authorize('leads', 'e'), validate({ params: s.idParams, body: s.statusSchema }), ctrl.setStatus);
router.patch('/:id/owner', authorize('leads', 'e'), validate({ params: s.idParams, body: s.ownerSchema }), ctrl.setOwner);
router.post('/:id/activities', authorize('leads', 'e'), validate({ params: s.idParams, body: s.activitySchema }), ctrl.addActivity);
router.delete('/:id', authorize('leads', 'd'), validate({ params: s.idParams }), ctrl.remove);

router.post('/:id/documents', authorize('leads', 'e'), validate({ params: s.idParams }), upload.array('files'), ctrl.uploadDocuments);

router.get('/:id/quotes', authorize('leads', 'v'), validate({ params: s.idParams }), ctrl.listQuotes);
router.post('/:id/quotes', authorize('leads', 'e'), validate({ params: s.idParams, body: s.quoteSchema }), ctrl.createQuote);
router.patch('/:id/quotes/:qid', authorize('leads', 'e'), validate({ params: s.quoteParams, body: s.quoteUpdateSchema }), ctrl.updateQuote);
router.post('/:id/quotes/:qid/send', authorize('leads', 'e'), validate({ params: s.quoteParams }), ctrl.sendQuote);
router.post('/:id/quotes/:qid/status', authorize('leads', 'e'), validate({ params: s.quoteParams, body: s.quoteStatusSchema }), ctrl.setQuoteStatus);
router.get('/:id/quotes/:qid/print', authorize('leads', 'v'), validate({ params: s.quoteParams }), ctrl.printQuote);

export default router;
