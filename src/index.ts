import '@kitajs/html/register';
import { Elysia, t } from 'elysia';
import { ElysiaWS } from 'elysia/ws';
import { staticPlugin } from '@elysiajs/static'
import { join, dirname } from 'path';
import cookie from '@elysiajs/cookie';
import jwt from '@elysiajs/jwt';
import { renderIndexPage, addWishlistItem, renderWishlist, renderSignInPage, authenticateWithJellyfin, getUser, isAdmin, getWishlistItem, editWishlistItem, deleteWishlistItem, createUser, getOrCreateUser } from './handlers';
import { AddEditModal } from './views/components/modals/AddEditModal';
import { ErrorModal } from './views/components/modals/ErrorModal';
import { User } from './types';
import { logger } from 'logixlysia';

const staticFilesDir = Bun.env.NODE_ENV === 'production' ? join(dirname(Bun.main), '..', 'public') : 'public';
export const basePath = Bun.env.BASE_PATH ?? '';

const updatableSockets: Array<{ws: ElysiaWS<any, any, any>, user: User}> = [];

export const app = new Elysia({prefix: basePath})
	.use(logger())
	.onError(console.error)
	.use(staticPlugin({assets: staticFilesDir, alwaysStatic: false, enableDecodeURI: true, indexHTML: false, prefix: '/public'}))
	.use(jwt({
		secret: Bun.env.JWT_SECRET!
	}))
	.use(cookie())

	.get('/', async ({ set, jwt, cookie: { wishlistauth, jellyfinId } }) => {
		const jwtauth = await jwt.verify(wishlistauth);

		if(!jwtauth){
			set.status = 401;
			set.redirect = `${basePath}/sign-in`;
			return 'Unauthorized';
		}

		const user = await getUser(jellyfinId);

		set.headers['Content-Type'] = 'text/html; charset=utf8';
		return await renderIndexPage(user);
	})
	.ws('/refreshlist', {
		open: async (ws) => {
			if(!(await registerWebSocketUser(ws, ws.data.cookie.jellyfinId))) return;

			console.log('subscribe list update', ws.id);
			ws.subscribe('refreshList');
		},
		close: (ws) => {
			removeWebSocketUser(ws.id);

			console.log('remove list update', ws.id);
			ws.unsubscribe('refreshList');
		},
		error: (e) => console.error(e.error),
		perMessageDeflate: true
	})
	.ws('/refresharchived', {
		open: async (ws) => {
			if(!(await registerWebSocketUser(ws, ws.data.cookie.jellyfinId))) return;

			console.log('subscribe archived update', ws.id);
			ws.subscribe('refreshArchived');
		},
		close: (ws) => {
			removeWebSocketUser(ws.id);

			console.log('remove archived update', ws.id);
			ws.unsubscribe('refreshArchived');
		},
		error: (e) => console.error(e.error),
		perMessageDeflate: true
	})

	.get('/sign-in', async ({ set, jwt, cookie: { wishlistauth } }) => {
		const jwtauth = await jwt.verify(wishlistauth);

		if(jwtauth){
			set.redirect = !!basePath ? basePath : '/';
			return '';
		}

		set.headers['Content-Type'] = 'text/html; charset=utf8';
		return await renderSignInPage();
	})
	.post('/sign-in', async ({ setCookie, jwt, body, set }) => {
		try{
			if((body?.username?.length ?? 0) === 0 || (body?.password?.length ?? 0) === 0) throw new Error('Unauthorized');

			const jellyfinAuth = await authenticateWithJellyfin(body.username, body.password);

			if(!(jellyfinAuth instanceof Object)) throw new Error('Unauthorized');

			const user = await getOrCreateUser(jellyfinAuth.User.Id, jellyfinAuth.User.Name);

			setCookie('wishlistauth', await jwt.sign(user), {
				httpOnly: true,
				maxAge: 7 * 86400,
				path: !!basePath ? basePath : '/'
			});
			setCookie('jellyfinId', user.jellyfinId, {
				httpOnly: true,
				maxAge: 7 * 86400,
				path: !!basePath ? basePath : '/'
			});
			setCookie('name', user.name, {
				httpOnly: true,
				maxAge: 7 * 86400,
				path: !!basePath ? basePath : '/'
			});

			console.log(`User ${user.name} signed in`);

			set.redirect = !!basePath ? basePath : '/';
			return '';
		}catch(e: any){
			console.error(`username: ${body.username ?? '%undefined%'} couldn't log in:`, e.message);
			set.status = 401;
			set.redirect = `${basePath}/sign-in`;
			return '';
		}
	}, {
		body: t.Object({
			username: t.String(),
			password: t.String()
		})
	})
	.get('/sign-out', async ({ removeCookie, set }) => {
		removeCookie('wishlistauth');
		set.redirect = `${basePath}/sign-in`;
		return '';
	})

	.group('/wishlist', (app) => app
		.get('/add', async ({ set, cookie }) => {
			set.headers['Content-Type'] = 'text/html; charset=utf8';
			return await AddEditModal({admin: isAdmin(cookie.jellyfinId as unknown as string ?? '')});
		})
		.post('/add', async ({ set, body, cookie: { jellyfinId } }) => {
			try{
				const user = await getUser(jellyfinId);
				if(!user) throw new Error('User not found!');

				await addWishlistItem({...body, ...{createdBy: user.jellyfinId}});
				console.log(`${user.name} added item ${body.name} (${body.year})`);

				await Promise.all([
					emitWishlistRefreshEvent(),
					emitArchivedlistRefreshEvent()
				]);
			}catch(e: any){
				console.error(e);
				set.headers['Content-Type'] = 'text/html; charset=utf8';
				set.status = 500;
				return await ErrorModal(e.message);
			}

			return '';
		}, {
			body: t.Object({
				//id - generated by database
				//status - generated by database, set later
				//lastStatusChange - generated by database, set later
				type: t.Numeric(),
				name: t.String(),
				poster: t.String(),
				createdBy: t.Optional(t.String()),
				//createdAt - generated by database
				year: t.Numeric(),
				imdbId: t.Optional(t.String()),
				tmdbId: t.Optional(t.String()),
				tvdbId: t.Optional(t.String())
			})
		})
		.get('/edit/:itemId', async ({ set, cookie, params: { itemId } }) => {
			const item = await getWishlistItem(Number(itemId));

			set.headers['Content-Type'] = 'text/html; charset=utf8';
			return await AddEditModal({item, admin: isAdmin(cookie.jellyfinId as unknown as string ?? '')});
		})
		.post('/edit', async ({ set, body, cookie: { jellyfinId } }) => {
			try{
				const user = await getUser(jellyfinId);
				if(!user) throw new Error('User not found!');

				await editWishlistItem(body);
				console.log(`${user.name} edited item ${body.id}`);

				await Promise.all([
					emitWishlistRefreshEvent(),
					emitArchivedlistRefreshEvent()
				]);
			}catch(e: any){
				console.error(e);
				set.headers['Content-Type'] = 'text/html; charset=utf8';
				set.status = 500;
				return await ErrorModal(e.message);
			}
		}, {
			body: t.Object({
				id: t.Optional(t.Numeric()),
				status: t.Optional(t.Numeric()),
				//lastStatusChange
				type: t.Optional(t.Numeric()),
				name: t.Optional(t.String()),
				poster: t.Optional(t.String()),
				createdBy: t.Optional(t.String()),
				//createdAt
				year: t.Optional(t.Numeric()),
				imdbId: t.Optional(t.String()),
				tmdbId: t.Optional(t.String()),
				tvdbId: t.Optional(t.String())
			})
		})
		.post('/delete/:itemId', async ({ params: {itemId}, cookie: { jellyfinId } }) => {
			const user = await getUser(jellyfinId);

			if(!user) return '';

			const deleteResult = await deleteWishlistItem(Number(itemId), user.jellyfinId);
			console.log(`User ${user.name} deleted item ${itemId}`);

			await Promise.all([
				emitWishlistRefreshEvent(),
				emitArchivedlistRefreshEvent()
			]);

			return '';
		})
	)
	.listen(3000);

console.log(`(${Bun.env.NODE_ENV}) 🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

const registerWebSocketUser = async (ws: ElysiaWS<any, any, any>, jellyfinId: string) => {
	const user = await getUser(jellyfinId);

	if(!user) return false;

	updatableSockets.push({ws: ws, user: user});

	return true;
}
const removeWebSocketUser = (wsId: string) => {
	const foundSocketIndex = updatableSockets.findIndex(usr => usr.ws.id === wsId);

	if(foundSocketIndex > -1){
		updatableSockets.splice(foundSocketIndex, 1);
		return true;
	}

	return false;
}

const emitWishlistRefreshEvent = async () => {
	for(const socketRef of updatableSockets){
		if(!socketRef.ws.isSubscribed('refreshList')) continue;

		const wishlist = await renderWishlist(socketRef.user, false);
		socketRef.ws.send(wishlist);
	}

	console.log('publish refreshList');
}
const emitArchivedlistRefreshEvent = async () => {
	for(const socketRef of updatableSockets){
		if(!socketRef.ws.isSubscribed('refreshArchived')) continue;

		const wishlist = await renderWishlist(socketRef.user, true);
		socketRef.ws.send(wishlist);
	}

	console.log('publish refreshArchived');
}