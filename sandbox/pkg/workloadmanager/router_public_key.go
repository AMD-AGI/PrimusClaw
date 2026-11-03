// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
)

// RouterPublicKeyReconciler writes the Router public key ConfigMap into the
// namespace of each new pod labeled with a sandbox id.
type RouterPublicKeyReconciler struct {
	Clientset kubernetes.Interface
}

// Reconcile ensures the public key ConfigMap in the pod's namespace.
func (r *RouterPublicKeyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	key := GetCachedPublicKey()
	if key == "" {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	return ctrl.Result{}, ensureRouterPublicKey(ctx, r.Clientset, req.Namespace, key)
}

// ensureRouterPublicKey creates or updates the public key ConfigMap in namespace.
func ensureRouterPublicKey(ctx context.Context, cs kubernetes.Interface, namespace, key string) error {
	configMaps := cs.CoreV1().ConfigMaps(namespace)
	cm, err := configMaps.Get(ctx, RouterPublicKeyConfigMap, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = configMaps.Create(ctx, &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: RouterPublicKeyConfigMap, Namespace: namespace},
			Data:       map[string]string{PublicKeyDataKey: key},
		}, metav1.CreateOptions{})
		if apierrors.IsAlreadyExists(err) {
			return ensureRouterPublicKey(ctx, cs, namespace, key)
		}
		return err
	}
	if err != nil {
		return err
	}
	if cm.Data[PublicKeyDataKey] == key {
		return nil
	}
	if cm.Data == nil {
		cm.Data = map[string]string{}
	}
	cm.Data[PublicKeyDataKey] = key
	_, err = configMaps.Update(ctx, cm, metav1.UpdateOptions{})
	return err
}

// SetupWithManager reconciles on the creation of pods labeled with a sandbox id.
func (r *RouterPublicKeyReconciler) SetupWithManager(mgr ctrl.Manager) error {
	sandboxPod := predicate.Funcs{
		CreateFunc:  func(e event.CreateEvent) bool { return e.Object.GetLabels()[sandboxIDLabel] != "" },
		UpdateFunc:  func(event.UpdateEvent) bool { return false },
		DeleteFunc:  func(event.DeleteEvent) bool { return false },
		GenericFunc: func(event.GenericEvent) bool { return false },
	}
	return ctrl.NewControllerManagedBy(mgr).
		Named("router-public-key").
		For(&corev1.Pod{}, builder.WithPredicates(sandboxPod)).
		Complete(r)
}
