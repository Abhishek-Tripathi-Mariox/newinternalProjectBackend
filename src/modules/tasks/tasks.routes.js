import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as ctrl from './tasks.controller.js';
import { checklistSchema, createTaskSchema, listTasksQuery, taskIdParams, updateTaskSchema } from './tasks.schemas.js';

/** /tasks — task board (module 'tasks'). */
const router = Router();
router.get('/', authorize('tasks', 'v'), validate({ query: listTasksQuery }), ctrl.list);
router.post('/', authorize('tasks', 'c'), validate({ body: createTaskSchema }), ctrl.create);
router.get('/:id', authorize('tasks', 'v'), validate({ params: taskIdParams }), ctrl.get);
router.patch('/:id', authorize('tasks', 'e'), validate({ params: taskIdParams, body: updateTaskSchema }), ctrl.update);
router.patch('/:id/checklist', authorize('tasks', 'e'), validate({ params: taskIdParams, body: checklistSchema }), ctrl.setChecklist);
router.delete('/:id', authorize('tasks', 'd'), validate({ params: taskIdParams }), ctrl.remove);
export default router;
